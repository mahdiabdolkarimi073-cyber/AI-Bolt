"""Provider adapters for real AI APIs.

Two adapter protocols are supported in Phase 6:

  1. OpenAI-compatible chat completions — suitable for GroqCloud, Cerebras,
     OpenRouter, and other services that expose a compatible endpoint.
  2. Google Gemini — uses Google's documented generateContent API protocol.

Adapters are provider-neutral: the Agent core and the connection manager work
against the `Adapter` protocol defined here, not against concrete SDKs. New
adapters can be added by implementing the protocol and registering in
`resolve_adapter()`.

Adapters NEVER log request headers, credentials, or full response bodies. They
return structured results the caller can serialize safely.
"""
from __future__ import annotations

import json as _json
from typing import Any, Generator, Optional, Protocol

import httpx

from app.ssrf import validate_endpoint, safe_request_kwargs


# --- Result types ---

class AdapterError(Exception):
    """Normalized adapter error. `category` is a safe, displayable code."""

    def __init__(self, category: str, message: str, *, status_code: Optional[int] = None):
        super().__init__(message)
        self.category = category
        self.message = message
        self.status_code = status_code


# Categories returned by connection tests and adapter runs.
CATEGORY_OK = "ok"
CATEGORY_AUTH_FAILED = "auth_failed"
CATEGORY_RATE_LIMITED = "rate_limited"
CATEGORY_QUOTA = "quota_or_billing"
CATEGORY_INVALID_MODEL = "invalid_model"
CATEGORY_INVALID_ENDPOINT = "invalid_endpoint"
CATEGORY_TIMEOUT = "timeout"
CATEGORY_NETWORK_ERROR = "network_error"
CATEGORY_PROVIDER_ERROR = "provider_error"
CATEGORY_NOT_CONFIGURED = "not_configured"


class ToolCall:
    """A single function/tool call extracted from a provider response."""
    def __init__(self, *, name: str, args: dict):
        self.name = name
        self.args = args

    def to_dict(self) -> dict:
        return {"name": self.name, "args": self.args}


class ChatResult:
    def __init__(self, *, content: str, simulated: bool = False, finish_reason: Optional[str] = None,
                 usage: Optional[dict] = None, raw_meta: Optional[dict] = None,
                 tool_calls: Optional[list[ToolCall]] = None):
        self.content = content
        self.simulated = simulated
        self.finish_reason = finish_reason
        self.usage = usage
        self.raw_meta = raw_meta or {}
        self.tool_calls = tool_calls or []


class TestResult:
    def __init__(self, *, category: str, message: str, status_code: Optional[int] = None):
        self.category = category
        self.message = message
        self.status_code = status_code

    def to_dict(self) -> dict:
        return {"category": self.category, "message": self.message, "statusCode": self.status_code}


class ListModelsResult:
    def __init__(self, *, models: list[str], raw_meta: Optional[dict] = None):
        self.models = models
        self.raw_meta = raw_meta or {}


class StreamChunk:
    """A single chunk from a streaming chat response."""
    def __init__(self, *, delta: str = "", tool_calls: Optional[list[ToolCall]] = None,
                 finish_reason: Optional[str] = None, usage: Optional[dict] = None):
        self.delta = delta
        self.tool_calls = tool_calls or []
        self.finish_reason = finish_reason
        self.usage = usage


class Adapter(Protocol):
    """Protocol every adapter implements."""

    adapter_id: str

    def validate_config(self, base_url: Optional[str]) -> str:
        ...

    def test(self, base_url: str, api_key: str, model: str) -> TestResult:
        ...

    def chat(self, base_url: str, api_key: str, model: str, messages: list[dict],
             *, timeout: float = 30.0, tools: Optional[list[dict]] = None) -> ChatResult:
        ...

    def chat_stream(self, base_url: str, api_key: str, model: str, messages: list[dict],
                    *, timeout: float = 120.0, tools: Optional[list[dict]] = None
                    ) -> Generator[StreamChunk, None, None]:
        ...

    def list_models(self, base_url: str, api_key: str, *, timeout: float = 20.0) -> ListModelsResult:
        ...


# --- HTTP error normalization ---

def _classify_http_error(status_code: int, body: Any) -> tuple[str, str]:
    """Map an HTTP error response to a safe (category, message) pair."""
    body_text = ""
    if isinstance(body, dict):
        # OpenAI-style: {"error": {"message": "..."}}
        err = body.get("error")
        if isinstance(err, dict):
            body_text = str(err.get("message") or "")
        elif isinstance(err, str):
            body_text = err
        # Gemini-style: {"error": {"message": "...", "status": "..."}}
    elif isinstance(body, str):
        body_text = body[:300]

    if status_code in (401, 403):
        return CATEGORY_AUTH_FAILED, "Authentication failed. Check the API key."
    if status_code == 429:
        return CATEGORY_RATE_LIMITED, "Rate limited by the provider. Try again later."
    if status_code in (402, 403):
        return CATEGORY_QUOTA, "Quota or billing issue with the provider."
    if status_code == 404:
        return CATEGORY_INVALID_MODEL, "Model or endpoint not found."
    if 500 <= status_code < 600:
        return CATEGORY_PROVIDER_ERROR, f"Provider error (HTTP {status_code})."
    return CATEGORY_PROVIDER_ERROR, f"Provider returned HTTP {status_code}."


# --- OpenAI-compatible adapter ---

class OpenAICompatibleAdapter:
    """Adapter for OpenAI-compatible chat completion endpoints.

    Suitable for GroqCloud, Cerebras, OpenRouter, and other compatible
    services. The base URL is user-configurable and validated against SSRF
    rules. Differences in capabilities are handled conservatively: unknown
    features are not assumed.
    """

    adapter_id = "openai_compatible"

    def validate_config(self, base_url: Optional[str]) -> str:
        if not base_url:
            raise AdapterError(CATEGORY_NOT_CONFIGURED, "Base URL is required for OpenAI-compatible connections.")
        return validate_endpoint(base_url, require_https=True)

    def _chat_url(self, base_url: str) -> str:
        url = base_url.rstrip("/")
        if url.endswith("/chat/completions"):
            return url
        if url.endswith("/v1"):
            return f"{url}/chat/completions"
        return f"{url}/v1/chat/completions"

    def test(self, base_url: str, api_key: str, model: str) -> TestResult:
        try:
            url = self.validate_config(base_url)
        except AdapterError as exc:
            return TestResult(category=exc.category, message=str(exc))
        except Exception as exc:
            return TestResult(category=CATEGORY_INVALID_ENDPOINT, message="Invalid endpoint URL.")
        if not api_key:
            return TestResult(category=CATEGORY_AUTH_FAILED, message="No API key provided for this connection.")
        if not model:
            return TestResult(category=CATEGORY_INVALID_MODEL, message="No model selected for the test.")
        # Minimal low-cost request: a single short user message, max_tokens 1.
        try:
            r = httpx.post(
                self._chat_url(url),
                headers=self._headers(api_key, _openrouter_headers(base_url)),
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": "ping"}],
                    "max_tokens": 1,
                    "temperature": 0,
                },
                **safe_request_kwargs(timeout=20.0),
            )
        except httpx.TimeoutException:
            return TestResult(category=CATEGORY_TIMEOUT, message="The request timed out.")
        except httpx.ConnectError:
            return TestResult(category=CATEGORY_NETWORK_ERROR, message="Could not connect to the endpoint.")
        except httpx.HTTPError as exc:
            return TestResult(category=CATEGORY_NETWORK_ERROR, message="Network error contacting the endpoint.")
        if r.status_code == 200:
            return TestResult(category=CATEGORY_OK, message="Connection successful.")
        body = _safe_json(r)
        cat, msg = _classify_http_error(r.status_code, body)
        return TestResult(category=cat, message=msg, status_code=r.status_code)

    def chat(self, base_url: str, api_key: str, model: str, messages: list[dict],
             *, timeout: float = 30.0, tools: Optional[list[dict]] = None) -> ChatResult:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        body_payload: dict = {"model": model, "messages": messages, "temperature": 0.2}
        if tools:
            body_payload["tools"] = [{"type": "function", "function": t} for t in tools]
        try:
            r = httpx.post(
                self._chat_url(url),
                headers=self._headers(api_key, _openrouter_headers(base_url)),
                json=body_payload,
                **safe_request_kwargs(timeout=timeout),
            )
        except httpx.TimeoutException as exc:
            raise AdapterError(CATEGORY_TIMEOUT, "The provider request timed out.") from exc
        except httpx.ConnectError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the provider.") from exc
        except httpx.HTTPError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Network error contacting the provider.") from exc
        if r.status_code != 200:
            body = _safe_json(r)
            cat, msg = _classify_http_error(r.status_code, body)
            raise AdapterError(cat, msg, status_code=r.status_code)
        body = _safe_json(r)
        if not isinstance(body, dict):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Provider returned a malformed response.")
        choices = body.get("choices") or []
        if not choices or not isinstance(choices, list):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Provider response had no choices.")
        first = choices[0]
        msg_obj = first.get("message") if isinstance(first, dict) else None
        content = (msg_obj or {}).get("content") if isinstance(msg_obj, dict) else None
        if not isinstance(content, str) or not content:
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Provider response had no content.")
        return ChatResult(
            content=content,
            finish_reason=first.get("finish_reason") if isinstance(first, dict) else None,
            usage=body.get("usage") if isinstance(body.get("usage"), dict) else None,
            raw_meta={"provider": "openai_compatible", "model": body.get("model")} if isinstance(body.get("model"), str) else {"provider": "openai_compatible"},
        )

    def chat_stream(self, base_url: str, api_key: str, model: str, messages: list[dict],
                    *, timeout: float = 120.0, tools: Optional[list[dict]] = None
                    ) -> Generator[StreamChunk, None, None]:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        body_payload: dict = {"model": model, "messages": messages, "temperature": 0.2, "stream": True}
        if tools:
            body_payload["tools"] = [{"type": "function", "function": t} for t in tools]
        try:
            with httpx.stream(
                "POST",
                self._chat_url(url),
                headers=self._headers(api_key, _openrouter_headers(base_url)),
                json=body_payload,
                **safe_request_kwargs(timeout=timeout),
            ) as r:
                if r.status_code != 200:
                    body = _safe_json(r)
                    cat, msg = _classify_http_error(r.status_code, body)
                    raise AdapterError(cat, msg, status_code=r.status_code)
                for line in r.iter_lines():
                    if not line or not line.startswith("data: "):
                        continue
                    data_str = line[6:]
                    if data_str.strip() == "[DONE]":
                        return
                    try:
                        chunk = _json.loads(data_str)
                    except _json.JSONDecodeError:
                        continue
                    choices = chunk.get("choices") or []
                    if not choices:
                        continue
                    first = choices[0]
                    if not isinstance(first, dict):
                        continue
                    delta_obj = first.get("delta")
                    delta_text = ""
                    tool_calls: list[ToolCall] = []
                    if isinstance(delta_obj, dict):
                        delta_text = delta_obj.get("content") or ""
                        raw_tcs = delta_obj.get("tool_calls")
                        if isinstance(raw_tcs, list):
                            for tc in raw_tcs:
                                if not isinstance(tc, dict):
                                    continue
                                fn = tc.get("function") or {}
                                name = fn.get("name")
                                if isinstance(name, str) and name:
                                    args_raw = fn.get("arguments")
                                    args: dict = {}
                                    if isinstance(args_raw, str):
                                        try:
                                            args = _json.loads(args_raw)
                                        except _json.JSONDecodeError:
                                            args = {}
                                    elif isinstance(args_raw, dict):
                                        args = args_raw
                                    tool_calls.append(ToolCall(name=name, args=args))
                    finish = first.get("finish_reason")
                    usage = chunk.get("usage") if isinstance(chunk.get("usage"), dict) else None
                    if delta_text or tool_calls or finish:
                        yield StreamChunk(delta=delta_text, tool_calls=tool_calls, finish_reason=finish, usage=usage)
        except httpx.TimeoutException as exc:
            raise AdapterError(CATEGORY_TIMEOUT, "The provider streaming request timed out.") from exc
        except httpx.ConnectError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the provider.") from exc
        except httpx.HTTPError as exc:
            if isinstance(exc, AdapterError):
                raise
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Network error during streaming.") from exc

    def _headers(self, api_key: str, *, extra: Optional[dict] = None) -> dict:
        h = {
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
        if extra:
            h.update(extra)
        return h

    def list_models(self, base_url: str, api_key: str, *, timeout: float = 20.0) -> ListModelsResult:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        models_url = url.rstrip("/")
        if models_url.endswith("/v1"):
            models_url = f"{models_url}/models"
        elif not models_url.endswith("/models"):
            models_url = f"{models_url}/v1/models"
        # OpenRouter requires HTTP-Referer and X-Title headers for model listing.
        extra: dict = {}
        if "openrouter.ai" in models_url.lower():
            extra["HTTP-Referer"] = "http://localhost:5173"
            extra["X-Title"] = "Personal AI IDE"
        try:
            r = httpx.get(
                models_url,
                headers=self._headers(api_key, extra=extra),
                **safe_request_kwargs(timeout=timeout),
            )
        except httpx.TimeoutException as exc:
            raise AdapterError(CATEGORY_TIMEOUT, "The model list request timed out.") from exc
        except httpx.ConnectError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the provider.") from exc
        except httpx.HTTPError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Network error contacting the provider.") from exc
        if r.status_code != 200:
            body = _safe_json(r)
            cat, msg = _classify_http_error(r.status_code, body)
            raise AdapterError(cat, msg, status_code=r.status_code)
        body = _safe_json(r)
        if not isinstance(body, dict):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Provider returned a malformed model list.")
        raw_models = body.get("data") or body.get("models") or []
        if not isinstance(raw_models, list):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Provider returned an unexpected model list format.")
        model_ids: list[str] = []
        for item in raw_models:
            if isinstance(item, str):
                model_ids.append(item)
            elif isinstance(item, dict):
                mid = item.get("id") or item.get("model")
                if isinstance(mid, str) and mid:
                    model_ids.append(mid)
        return ListModelsResult(models=model_ids, raw_meta={"count": len(model_ids)})


# --- Google Gemini adapter ---

class GeminiAdapter:
    """Adapter for Google's Gemini API (generateContent).

    Uses Google's documented REST protocol, not an OpenAI-compatible shim. The
    API key is sent as a query parameter (`?key=...`) per Google's spec. The
    base URL defaults to the public Gemini endpoint but is user-configurable.
    """

    adapter_id = "gemini"
    DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"

    def validate_config(self, base_url: Optional[str]) -> str:
        url = base_url or self.DEFAULT_BASE
        return validate_endpoint(url, require_https=True)

    def _model_url(self, base_url: str, model: str, *, stream: bool = False) -> str:
        url = base_url.rstrip("/")
        method = "streamGenerateContent" if stream else "generateContent"
        return f"{url}/models/{model}:{method}?key=API_KEY_PLACEHOLDER"

    def test(self, base_url: str, api_key: str, model: str) -> TestResult:
        try:
            url = self.validate_config(base_url)
        except AdapterError as exc:
            return TestResult(category=exc.category, message=str(exc))
        except Exception:
            return TestResult(category=CATEGORY_INVALID_ENDPOINT, message="Invalid endpoint URL.")
        if not api_key:
            return TestResult(category=CATEGORY_AUTH_FAILED, message="No API key provided for this connection.")
        if not model:
            return TestResult(category=CATEGORY_INVALID_MODEL, message="No model selected for the test.")
        # Minimal low-cost request.
        try:
            r = httpx.post(
                self._model_url(url, model).replace("API_KEY_PLACEHOLDER", _q(api_key)),
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"role": "user", "parts": [{"text": "ping"}]}],
                    "generationConfig": {"maxOutputTokens": 1, "temperature": 0},
                },
                **safe_request_kwargs(timeout=20.0),
            )
        except httpx.TimeoutException:
            return TestResult(category=CATEGORY_TIMEOUT, message="The request timed out.")
        except httpx.ConnectError:
            return TestResult(category=CATEGORY_NETWORK_ERROR, message="Could not connect to the Gemini endpoint.")
        except httpx.HTTPError:
            return TestResult(category=CATEGORY_NETWORK_ERROR, message="Network error contacting the endpoint.")
        if r.status_code == 200:
            return TestResult(category=CATEGORY_OK, message="Connection successful.")
        body = _safe_json(r)
        cat, msg = _classify_http_error(r.status_code, body)
        return TestResult(category=cat, message=msg, status_code=r.status_code)

    def chat(self, base_url: str, api_key: str, model: str, messages: list[dict],
             *, timeout: float = 30.0, tools: Optional[list[dict]] = None) -> ChatResult:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        # Convert OpenAI-style messages to Gemini's contents/parts format.
        contents = self._to_gemini_contents(messages)
        system_instruction = self._extract_system(messages)
        payload: dict = {
            "contents": contents,
            "generationConfig": {"temperature": 0.2},
        }
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
        if tools:
            payload["tools"] = [{"functionDeclarations": tools}]
        try:
            r = httpx.post(
                self._model_url(url, model).replace("API_KEY_PLACEHOLDER", _q(api_key)),
                headers={"Content-Type": "application/json"},
                json=payload,
                **safe_request_kwargs(timeout=timeout),
            )
        except httpx.TimeoutException as exc:
            raise AdapterError(CATEGORY_TIMEOUT, "The Gemini request timed out.") from exc
        except httpx.ConnectError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the Gemini endpoint.") from exc
        except httpx.HTTPError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Network error contacting the Gemini endpoint.") from exc
        if r.status_code != 200:
            body = _safe_json(r)
            cat, msg = _classify_http_error(r.status_code, body)
            raise AdapterError(cat, msg, status_code=r.status_code)
        body = _safe_json(r)
        if not isinstance(body, dict):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini returned a malformed response.")
        candidates = body.get("candidates") or []
        if not candidates:
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini response had no candidates.")
        first = candidates[0]
        if not isinstance(first, dict):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini response had no candidates.")
        content = self._extract_text(first.get("content"))
        # Extract function calls (tool calls) from the response.
        tool_calls = self._extract_tool_calls(first.get("content"))
        finish = first.get("finishReason") if isinstance(first, dict) else None
        usage = body.get("usageMetadata") if isinstance(body.get("usageMetadata"), dict) else None
        # Preserve provider-reported metadata so the caller can verify which
        # model actually executed. modelVersion is Google's authoritative
        # actual-model field; responseId uniquely identifies the request.
        model_version = body.get("modelVersion") if isinstance(body.get("modelVersion"), str) else None
        response_id = body.get("responseId") if isinstance(body.get("responseId"), str) else None
        raw_meta: dict = {"provider": "gemini"}
        if model_version:
            raw_meta["modelVersion"] = model_version
        if response_id:
            raw_meta["responseId"] = response_id
        # If there are tool calls, content may be empty — that's valid.
        if not content and not tool_calls:
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini response had no content or tool calls.")
        return ChatResult(
            content=content,
            finish_reason=finish,
            usage=usage,
            raw_meta=raw_meta,
            tool_calls=tool_calls,
        )

    def chat_stream(self, base_url: str, api_key: str, model: str, messages: list[dict],
                    *, timeout: float = 120.0, tools: Optional[list[dict]] = None
                    ) -> Generator[StreamChunk, None, None]:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        contents = self._to_gemini_contents(messages)
        system_instruction = self._extract_system(messages)
        payload: dict = {
            "contents": contents,
            "generationConfig": {"temperature": 0.2},
        }
        if system_instruction:
            payload["systemInstruction"] = {"parts": [{"text": system_instruction}]}
        if tools:
            payload["tools"] = [{"functionDeclarations": tools}]
        try:
            with httpx.stream(
                "POST",
                self._model_url(url, model, stream=True).replace("API_KEY_PLACEHOLDER", _q(api_key)),
                headers={"Content-Type": "application/json"},
                json=payload,
                **safe_request_kwargs(timeout=timeout),
            ) as r:
                if r.status_code != 200:
                    body = _safe_json(r)
                    cat, msg = _classify_http_error(r.status_code, body)
                    raise AdapterError(cat, msg, status_code=r.status_code)
                for line in r.iter_lines():
                    if not line:
                        continue
                    data_str = line
                    if data_str.startswith("data: "):
                        data_str = data_str[6:]
                    data_str = data_str.strip()
                    if not data_str or data_str == "[DONE]":
                        continue
                    try:
                        parsed = _json.loads(data_str)
                    except _json.JSONDecodeError:
                        continue
                    chunks = parsed if isinstance(parsed, list) else [parsed]
                    for chunk in chunks:
                        if not isinstance(chunk, dict):
                            continue
                        candidates = chunk.get("candidates") or []
                        if not candidates:
                            continue
                        first = candidates[0]
                        if not isinstance(first, dict):
                            continue
                        content = first.get("content")
                        delta_text = self._extract_text(content)
                        tool_calls = self._extract_tool_calls(content)
                        finish = first.get("finishReason")
                        usage = chunk.get("usageMetadata") if isinstance(chunk.get("usageMetadata"), dict) else None
                        if delta_text or tool_calls or finish:
                            yield StreamChunk(delta=delta_text, tool_calls=tool_calls, finish_reason=finish, usage=usage)
        except httpx.TimeoutException as exc:
            raise AdapterError(CATEGORY_TIMEOUT, "The Gemini streaming request timed out.") from exc
        except httpx.ConnectError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the Gemini endpoint.") from exc
        except httpx.HTTPError as exc:
            if isinstance(exc, AdapterError):
                raise
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Network error during Gemini streaming.") from exc

    def list_models(self, base_url: str, api_key: str, *, timeout: float = 20.0) -> ListModelsResult:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        models_url = f"{url.rstrip('/')}/models?key={_q(api_key)}"
        try:
            r = httpx.get(
                models_url,
                headers={"Content-Type": "application/json"},
                **safe_request_kwargs(timeout=timeout),
            )
        except httpx.TimeoutException as exc:
            raise AdapterError(CATEGORY_TIMEOUT, "The model list request timed out.") from exc
        except httpx.ConnectError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the Gemini endpoint.") from exc
        except httpx.HTTPError as exc:
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Network error contacting the Gemini endpoint.") from exc
        if r.status_code != 200:
            body = _safe_json(r)
            cat, msg = _classify_http_error(r.status_code, body)
            raise AdapterError(cat, msg, status_code=r.status_code)
        body = _safe_json(r)
        if not isinstance(body, dict):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini returned a malformed model list.")
        raw_models = body.get("models") or []
        if not isinstance(raw_models, list):
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini returned an unexpected model list format.")
        model_ids: list[str] = []
        for item in raw_models:
            if isinstance(item, dict):
                name = item.get("name") or item.get("model")
                if isinstance(name, str) and name:
                    model_ids.append(name)
            elif isinstance(item, str):
                model_ids.append(item)
        return ListModelsResult(models=model_ids, raw_meta={"count": len(model_ids)})

    def _to_gemini_contents(self, messages: list[dict]) -> list[dict]:
        contents: list[dict] = []
        for m in messages:
            role = m.get("role")
            if role == "system":
                continue  # handled separately as systemInstruction
            # Messages with tool_calls represent the model's function call —
            # emit them as "model" role with functionCall parts.
            tool_calls = m.get("tool_calls")
            if tool_calls and isinstance(tool_calls, list):
                parts: list[dict] = []
                for tc in tool_calls:
                    parts.append({"functionCall": {"name": tc["name"], "args": tc.get("args", {})}})
                contents.append({"role": "model", "parts": parts})
                continue
            g_role = "user" if role == "user" else "model"
            contents.append({"role": g_role, "parts": [{"text": m.get("content", "")}]})
        return contents

    def _extract_system(self, messages: list[dict]) -> str:
        """Concatenate ALL system messages into the systemInstruction.

        Multiple system messages are injected by the agent route (user prompt,
        runtime metadata, retrieval block, project context). Gemini only accepts
        a single systemInstruction, so they must be joined here.
        """
        parts: list[str] = []
        for m in messages:
            if m.get("role") == "system":
                c = str(m.get("content") or "")
                if c:
                    parts.append(c)
        return "\n\n".join(parts)

    def _extract_tool_calls(self, content: Any) -> list[ToolCall]:
        """Extract function calls from a Gemini candidate content."""
        if not isinstance(content, dict):
            return []
        parts = content.get("parts") or []
        calls: list[ToolCall] = []
        for p in parts:
            if not isinstance(p, dict):
                continue
            fc = p.get("functionCall")
            if not isinstance(fc, dict):
                continue
            name = fc.get("name")
            args = fc.get("args")
            if isinstance(name, str) and name:
                calls.append(ToolCall(name=name, args=args if isinstance(args, dict) else {}))
        return calls

    def _extract_text(self, content: Any) -> str:
        if not isinstance(content, dict):
            return ""
        parts = content.get("parts") or []
        texts = []
        for p in parts:
            if isinstance(p, dict) and isinstance(p.get("text"), str):
                texts.append(p["text"])
        return "".join(texts)


# --- Registry ---

_ADAPTERS: dict[str, Adapter] = {
    "openai_compatible": OpenAICompatibleAdapter(),
    "gemini": GeminiAdapter(),
}


def resolve_adapter(adapter_id: str) -> Adapter:
    """Return the adapter for a given adapter id. Raises ValueError if unknown."""
    a = _ADAPTERS.get(adapter_id)
    if a is None:
        raise ValueError(f"Unknown adapter: {adapter_id}")
    return a


def supported_adapters() -> list[str]:
    return list(_ADAPTERS.keys())


# --- Helpers ---

def _safe_json(response: httpx.Response) -> Any:
    try:
        return response.json()
    except Exception:
        return None


def _q(value: str) -> str:
    """Minimal query-parameter escaper for the API key."""
    return value.replace("&", "%26").replace("=", "%3D").replace("+", "%2B").replace(" ", "%20")


def _openrouter_headers(base_url: Optional[str]) -> dict:
    """Return extra headers required by OpenRouter."""
    if base_url and "openrouter.ai" in base_url.lower():
        return {"HTTP-Referer": "http://localhost:5173", "X-Title": "Personal AI IDE"}
    return {}
