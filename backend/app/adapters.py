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

from typing import Any, Optional, Protocol

import httpx

from app.ssrf import validate_endpoint, safe_request_kwargs


# --- Result types ---

class AdapterError(Exception):
    """Normalized adapter error. `category` is a safe, displayable code."""

    def __init__(self, category: str, message: str, *, status_code: Optional[int] = None):
        super().__init__(message)
        self.category = category
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


class ChatResult:
    def __init__(self, *, content: str, simulated: bool = False, finish_reason: Optional[str] = None,
                 usage: Optional[dict] = None, raw_meta: Optional[dict] = None):
        self.content = content
        self.simulated = simulated
        self.finish_reason = finish_reason
        self.usage = usage
        self.raw_meta = raw_meta or {}


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


class Adapter(Protocol):
    """Protocol every adapter implements."""

    adapter_id: str

    def validate_config(self, base_url: Optional[str]) -> str:
        ...

    def test(self, base_url: str, api_key: str, model: str) -> TestResult:
        ...

    def chat(self, base_url: str, api_key: str, model: str, messages: list[dict],
             *, timeout: float = 30.0) -> ChatResult:
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
             *, timeout: float = 30.0) -> ChatResult:
        url = self.validate_config(base_url)
        if not api_key:
            raise AdapterError(CATEGORY_AUTH_FAILED, "No API key available for this connection.")
        try:
            r = httpx.post(
                self._chat_url(url),
                headers=self._headers(api_key, _openrouter_headers(base_url)),
                json={"model": model, "messages": messages, "temperature": 0.2},
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
            raw_meta={"provider": "openai_compatible"},
        )

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
             *, timeout: float = 30.0) -> ChatResult:
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
        content = self._extract_text(first.get("content")) if isinstance(first, dict) else ""
        if not content:
            raise AdapterError(CATEGORY_PROVIDER_ERROR, "Gemini response had no content.")
        finish = first.get("finishReason") if isinstance(first, dict) else None
        usage = body.get("usageMetadata") if isinstance(body.get("usageMetadata"), dict) else None
        return ChatResult(
            content=content,
            finish_reason=finish,
            usage=usage,
            raw_meta={"provider": "gemini"},
        )

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
            g_role = "user" if role == "user" else "model"
            contents.append({"role": g_role, "parts": [{"text": m.get("content", "")}]})
        return contents

    def _extract_system(self, messages: list[dict]) -> str:
        for m in messages:
            if m.get("role") == "system":
                return str(m.get("content") or "")
        return ""

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
