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
import logging
import time
from typing import Any, Generator, Optional, Protocol

import httpx

from app.ssrf import validate_endpoint, safe_request_kwargs
from app.logging_config import log_provider, log_error, log_agent, is_debug_enabled


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
    def __init__(self, *, name: str, args: dict, thought_signature: Optional[str] = None):
        self.name = name
        self.args = args
        self.thought_signature = thought_signature

    def to_dict(self) -> dict:
        d = {"name": self.name, "args": self.args}
        if self.thought_signature is not None:
            d["thought_signature"] = self.thought_signature
        return d


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
        msg = f"Provider error (HTTP {status_code})."
        if body_text:
            msg = f"{msg} {body_text[:300]}"
        return CATEGORY_PROVIDER_ERROR, msg
    msg = f"Provider returned HTTP {status_code}."
    if body_text:
        msg = f"{msg} {body_text[:300]}"
    return CATEGORY_PROVIDER_ERROR, msg


def _extract_provider_error_detail(body: Any) -> dict:
    """Extract structured error details from a provider error response for logging.

    Returns a dict with safe, bounded fields. No secrets, API keys, or auth headers
    are included — only the provider's structured error code, status, and message.
    """
    detail: dict = {}
    if isinstance(body, dict):
        err = body.get("error")
        if isinstance(err, dict):
            if err.get("code") is not None:
                detail["errorCode"] = err["code"]
            if err.get("status") is not None:
                detail["errorStatus"] = err["status"]
            msg = err.get("message")
            if isinstance(msg, str):
                detail["errorMessage"] = msg[:500]
            if err.get("details") is not None:
                try:
                    detail["errorDetails"] = _json.dumps(err["details"], ensure_ascii=False)[:800]
                except Exception:
                    detail["errorDetails"] = str(err["details"])[:800]
        elif isinstance(err, str):
            detail["errorMessage"] = err[:500]
        if body.get("promptFeedback") is not None:
            try:
                detail["promptFeedback"] = _json.dumps(body["promptFeedback"], ensure_ascii=False)[:400]
            except Exception:
                pass
    elif isinstance(body, str):
        detail["errorMessage"] = body[:500]
    return detail


def _summarize_gemini_contents(contents: list[dict]) -> dict:
    """Build a safe summary of the Gemini contents array for diagnostic logging.

    Logs only roles and part types (functionCall/functionResponse names), never
    text content, arguments, or response data.
    """
    entries = []
    for c in contents:
        if not isinstance(c, dict):
            continue
        role = c.get("role", "?")
        parts = c.get("parts") or []
        part_summary = []
        for p in parts:
            if not isinstance(p, dict):
                continue
            if "text" in p:
                part_summary.append("text")
            elif "functionCall" in p:
                fc = p.get("functionCall", {})
                part_summary.append(f"functionCall({fc.get('name', '?')})")
            elif "functionResponse" in p:
                fr = p.get("functionResponse", {})
                part_summary.append(f"functionResponse({fr.get('name', '?')})")
            else:
                part_summary.append("unknown")
        entries.append({"role": role, "parts": part_summary})
    return {"count": len(contents), "entries": entries}


def _read_streaming_body(response: httpx.Response) -> Any:
    """Read and parse the body from a streaming httpx response.

    In streaming mode, the body may not be fully buffered. This reads it
    first, then attempts to parse as JSON. Returns parsed JSON, raw text, or None.
    """
    try:
        response.read()
    except Exception:
        pass
    try:
        return response.json()
    except Exception:
        try:
            return response.text[:1000] if response.text else None
        except Exception:
            return None


def _classify_httpx_timeout(exc: httpx.TimeoutException) -> str:
    """Classify the phase where an httpx timeout occurred based on the exception subclass."""
    if isinstance(exc, httpx.ConnectTimeout):
        return "connect"
    if isinstance(exc, httpx.ReadTimeout):
        return "read_stream"
    if isinstance(exc, httpx.WriteTimeout):
        return "write_request"
    if isinstance(exc, httpx.PoolTimeout):
        return "connection_pool"
    return "unknown"


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
        log_agent("OpenAI-compatible chat — response parsed",
                  model=model,
                  has_content=bool(content),
                  content_len=len(content) if content else 0,
                  finish_reason=first.get("finish_reason") if isinstance(first, dict) else None,
                  level=20)  # INFO
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
                    try:
                        body = _read_streaming_body(r)
                    except Exception as read_exc:
                        log_error("OpenAI stream — failed to read error body", exc=read_exc)
                        body = None
                    err_detail = _extract_provider_error_detail(body)
                    log_provider("OpenAI stream — provider error response",
                                 http_status=r.status_code,
                                 model=model,
                                 content_type=r.headers.get("content-type", "(none)"),
                                 error_detail=err_detail)
                    log_agent("OpenAI stream — provider error diagnostics",
                              model=model,
                              http_status=r.status_code,
                              error_code=err_detail.get("errorCode"),
                              error_status=err_detail.get("errorStatus"),
                              error_message=err_detail.get("errorMessage", "")[:200],
                              error_details=err_detail.get("errorDetails", "")[:200],
                              message_count=len(messages),
                              message_roles=[m.get("role", "?") for m in messages],
                              has_tools=bool(tools),
                              tools_count=len(tools) if tools else 0,
                              tool_names=[t.get("name", "?") for t in tools] if tools else [],
                              level=logging.ERROR)
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
        # Google's streamGenerateContent returns a JSON array by default.
        # alt=sse switches it to Server-Sent Events (data: <json> lines),
        # which is the format our line parser expects.
        if stream:
            return f"{url}/models/{model}:{method}?alt=sse&key=API_KEY_PLACEHOLDER"
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
            err_detail = _extract_provider_error_detail(body)
            log_provider("Gemini chat — provider error response",
                         http_status=r.status_code,
                         model=model,
                         content_type=r.headers.get("content-type", "(none)"),
                         error_detail=err_detail)
            log_agent("Gemini chat — provider error diagnostics",
                      model=model,
                      http_status=r.status_code,
                      error_code=err_detail.get("errorCode"),
                      error_status=err_detail.get("errorStatus"),
                      error_message=err_detail.get("errorMessage", "")[:200],
                      error_details=err_detail.get("errorDetails", "")[:200],
                      prompt_feedback=err_detail.get("promptFeedback", ""),
                      contents_summary=_summarize_gemini_contents(contents),
                      has_system_instruction=bool(system_instruction),
                      tools_count=len(tools) if tools else 0,
                      tool_names=[t.get("name", "?") for t in tools] if tools else [],
                      level=logging.ERROR)
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
        log_agent("Gemini chat — response parsed",
                  model=model,
                  has_content=bool(content),
                  content_len=len(content) if content else 0,
                  tool_call_count=len(tool_calls),
                  tool_call_names=[tc.name for tc in tool_calls] if tool_calls else [],
                  finish_reason=finish or "(none)",
                  level=20)  # INFO
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
        # Diagnostic counters (dev only — no secrets or content logged).
        _dbg = is_debug_enabled()
        _lines_total = 0
        _lines_parsed = 0
        _lines_skipped = 0
        _text_chunks = 0
        _tool_chunks = 0
        _finish_reason_seen: Optional[str] = None
        _sse_sent = 0
        _stream_t0 = time.time()

        try:
            with httpx.stream(
                "POST",
                self._model_url(url, model, stream=True).replace("API_KEY_PLACEHOLDER", _q(api_key)),
                headers={"Content-Type": "application/json"},
                json=payload,
                **safe_request_kwargs(timeout=timeout),
            ) as r:
                if _dbg:
                    log_provider("Gemini stream response", http_status=r.status_code,
                                 content_type=r.headers.get("content-type", "(none)"))
                if r.status_code != 200:
                    try:
                        body = _read_streaming_body(r)
                    except Exception as read_exc:
                        log_error("Gemini stream — failed to read error body", exc=read_exc)
                        body = None
                    err_detail = _extract_provider_error_detail(body)
                    log_provider("Gemini stream — provider error response",
                                 http_status=r.status_code,
                                 model=model,
                                 content_type=r.headers.get("content-type", "(none)"),
                                 error_detail=err_detail)
                    log_agent("Gemini stream — provider error diagnostics",
                              model=model,
                              http_status=r.status_code,
                              error_code=err_detail.get("errorCode"),
                              error_status=err_detail.get("errorStatus"),
                              error_message=err_detail.get("errorMessage", "")[:200],
                              error_details=err_detail.get("errorDetails", "")[:200],
                              prompt_feedback=err_detail.get("promptFeedback", ""),
                              contents_summary=_summarize_gemini_contents(contents),
                              has_system_instruction=bool(system_instruction),
                              tools_count=len(tools) if tools else 0,
                              tool_names=[t.get("name", "?") for t in tools] if tools else [],
                              level=logging.ERROR)
                    cat, msg = _classify_http_error(r.status_code, body)
                    raise AdapterError(cat, msg, status_code=r.status_code)
                for line in r.iter_lines():
                    _lines_total += 1
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
                        _lines_skipped += 1
                        if _dbg:
                            log_provider("Gemini stream line skipped (parse error)",
                                         line_len=len(data_str),
                                         preview=data_str[:80])
                        continue
                    _lines_parsed += 1
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
                        if finish:
                            _finish_reason_seen = finish
                        usage = chunk.get("usageMetadata") if isinstance(chunk.get("usageMetadata"), dict) else None
                        if delta_text or tool_calls or finish:
                            if delta_text:
                                _text_chunks += 1
                            if tool_calls:
                                _tool_chunks += 1
                            _sse_sent += 1
                            yield StreamChunk(delta=delta_text, tool_calls=tool_calls, finish_reason=finish, usage=usage)
                if _dbg:
                    log_provider("Gemini stream diagnostics",
                                 lines_total=_lines_total,
                                 lines_parsed=_lines_parsed,
                                 lines_skipped=_lines_skipped,
                                 text_chunks=_text_chunks,
                                 tool_chunks=_tool_chunks,
                                 finish_reason=_finish_reason_seen or "(none)",
                                 sse_sent=_sse_sent)
                log_agent("Gemini stream — diagnostics summary",
                          model=model,
                          lines_total=_lines_total,
                          text_chunks=_text_chunks,
                          tool_chunks=_tool_chunks,
                          finish_reason=_finish_reason_seen or "(none)",
                          sse_sent=_sse_sent,
                          level=20)
                # Fallback: if alt=sse was not honored and Gemini returned a JSON
                # array, no SSE lines will have been parsed. Re-read the full body
                # and parse it as a JSON array of chunks.
                if _sse_sent == 0 and _lines_parsed == 0:
                    if _dbg:
                        log_provider("Gemini stream fallback: no SSE lines parsed, trying JSON array")
                    raw_bytes = r.read()
                    try:
                        parsed_array = _json.loads(raw_bytes)
                    except Exception:
                        parsed_array = None
                    if isinstance(parsed_array, list):
                        for chunk in parsed_array:
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
                            if finish:
                                _finish_reason_seen = finish
                            usage = chunk.get("usageMetadata") if isinstance(chunk.get("usageMetadata"), dict) else None
                            if delta_text or tool_calls or finish:
                                if delta_text:
                                    _text_chunks += 1
                                if tool_calls:
                                    _tool_chunks += 1
                                _sse_sent += 1
                                yield StreamChunk(delta=delta_text, tool_calls=tool_calls, finish_reason=finish, usage=usage)
                        if _dbg:
                            log_provider("Gemini stream fallback diagnostics",
                                         array_len=len(parsed_array),
                                         text_chunks=_text_chunks,
                                         tool_chunks=_tool_chunks,
                                         finish_reason=_finish_reason_seen or "(none)",
                                         sse_sent=_sse_sent)
        except httpx.TimeoutException as exc:
            _phase = _classify_httpx_timeout(exc)
            _elapsed_ms = int((time.time() - _stream_t0) * 1000)
            _chained = type(exc.__cause__).__name__ if exc.__cause__ else None
            log_error("Gemini streaming timeout",
                      exception_type=type(exc).__name__,
                      error_category=CATEGORY_TIMEOUT,
                      model=model,
                      timeout_phase=_phase,
                      elapsed_ms=_elapsed_ms,
                      chained_exception_type=_chained or "(none)")
            log_agent("Gemini stream — timeout diagnostics",
                      model=model,
                      error_category=CATEGORY_TIMEOUT,
                      exception_type=type(exc).__name__,
                      timeout_phase=_phase,
                      elapsed_ms=_elapsed_ms,
                      chained_exception_type=_chained or "(none)",
                      level=logging.ERROR)
            raise AdapterError(CATEGORY_TIMEOUT, "The Gemini streaming request timed out.") from exc
        except httpx.ConnectError as exc:
            _elapsed_ms = int((time.time() - _stream_t0) * 1000)
            _chained = type(exc.__cause__).__name__ if exc.__cause__ else None
            log_error("Gemini streaming connection error",
                      exception_type=type(exc).__name__,
                      error_category=CATEGORY_NETWORK_ERROR,
                      model=model,
                      elapsed_ms=_elapsed_ms,
                      chained_exception_type=_chained or "(none)")
            log_agent("Gemini stream — connection error diagnostics",
                      model=model,
                      error_category=CATEGORY_NETWORK_ERROR,
                      exception_type=type(exc).__name__,
                      elapsed_ms=_elapsed_ms,
                      chained_exception_type=_chained or "(none)",
                      level=logging.ERROR)
            raise AdapterError(CATEGORY_NETWORK_ERROR, "Could not connect to the Gemini endpoint.") from exc
        except httpx.HTTPError as exc:
            if isinstance(exc, AdapterError):
                raise
            _elapsed_ms = int((time.time() - _stream_t0) * 1000)
            _chained = type(exc.__cause__).__name__ if exc.__cause__ else None
            log_error("Gemini streaming HTTP error",
                      exception_type=type(exc).__name__,
                      error_category=CATEGORY_NETWORK_ERROR,
                      model=model,
                      elapsed_ms=_elapsed_ms,
                      chained_exception_type=_chained or "(none)")
            log_agent("Gemini stream — HTTP error diagnostics",
                      model=model,
                      error_category=CATEGORY_NETWORK_ERROR,
                      exception_type=type(exc).__name__,
                      elapsed_ms=_elapsed_ms,
                      chained_exception_type=_chained or "(none)",
                      level=logging.ERROR)
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
        i = 0
        while i < len(messages):
            m = messages[i]
            role = m.get("role")
            if role == "system":
                i += 1
                continue  # handled separately as systemInstruction
            # Messages with tool_calls represent the model's function call —
            # emit them as "model" role with functionCall parts.
            # Merge consecutive tool_calls messages into one model turn.
            tool_calls = m.get("tool_calls")
            if tool_calls and isinstance(tool_calls, list):
                parts: list[dict] = []
                while i < len(messages):
                    tc = messages[i].get("tool_calls")
                    if not (tc and isinstance(tc, list)):
                        break
                    for entry in tc:
                        fc_part: dict = {"name": entry["name"], "args": entry.get("args", {})}
                        part: dict = {"functionCall": fc_part}
                        thought_sig = entry.get("thought_signature")
                        if isinstance(thought_sig, str) and thought_sig:
                            # thoughtSignature is a sibling of functionCall on
                            # the Part object, not a nested field inside it.
                            part["thoughtSignature"] = thought_sig
                        parts.append(part)
                    i += 1
                contents.append({"role": "model", "parts": parts})
                _sig_count = sum(1 for p in parts if isinstance(p, dict) and isinstance(p.get("functionCall", {}).get("thoughtSignature"), str))
                log_agent("Gemini _to_gemini_contents — model turn serialized",
                          part_count=len(parts),
                          parts_with_signature=_sig_count,
                          parts_without_signature=len(parts) - _sig_count,
                          level=logging.DEBUG if is_debug_enabled() else logging.INFO)
                continue
            # Messages with tool_result represent the function response —
            # emit them as "user" role with functionResponse parts per Gemini spec.
            # Merge consecutive tool_result messages into one user turn.
            tool_result = m.get("tool_result")
            if tool_result and isinstance(tool_result, dict):
                parts: list[dict] = []
                while i < len(messages):
                    tr = messages[i].get("tool_result")
                    if not (tr and isinstance(tr, dict)):
                        break
                    name = tr.get("name", "")
                    result = tr.get("result", {})
                    if not isinstance(result, dict):
                        result = {"result": result}
                    if not result:
                        result = {"status": "ok"}
                    parts.append({"functionResponse": {"name": name, "response": result}})
                    i += 1
                contents.append({"role": "user", "parts": parts})
                continue
            g_role = "user" if role == "user" else "model"
            contents.append({"role": g_role, "parts": [{"text": m.get("content", "")}]})
            i += 1
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
        """Extract function calls from a Gemini candidate content.

        Gemini returns the thought signature as ``thoughtSignature`` (camelCase).
        Some proxy/SDK wrappers may use ``thought_signature`` (snake_case) — we
        check both so the signature is never silently dropped.
        """
        if not isinstance(content, dict):
            return []
        parts = content.get("parts") or []
        calls: list[ToolCall] = []
        _sigs_found = 0
        _sigs_missing = 0
        for p in parts:
            if not isinstance(p, dict):
                continue
            fc = p.get("functionCall")
            if not isinstance(fc, dict):
                continue
            name = fc.get("name")
            args = fc.get("args")
            # thoughtSignature is a sibling of functionCall on the Part object,
            # not a nested field inside functionCall.  Check the part level first,
            # then fall back to the functionCall level for proxy/SDK variants.
            thought_sig = p.get("thoughtSignature") or p.get("thought_signature")
            if not thought_sig:
                thought_sig = fc.get("thoughtSignature") or fc.get("thought_signature")
            if isinstance(name, str) and name:
                sig_val = thought_sig if isinstance(thought_sig, str) and thought_sig else None
                if sig_val:
                    _sigs_found += 1
                else:
                    _sigs_missing += 1
                calls.append(ToolCall(
                    name=name,
                    args=args if isinstance(args, dict) else {},
                    thought_signature=sig_val,
                ))
        if calls:
            log_agent("Gemini _extract_tool_calls — signature diagnostics",
                      tool_call_count=len(calls),
                      tool_call_names=[c.name for c in calls],
                      signatures_found=_sigs_found,
                      signatures_missing=_sigs_missing,
                      level=logging.DEBUG if is_debug_enabled() else logging.INFO)
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
