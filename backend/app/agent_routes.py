"""Agent execution route for the FastAPI backend.

Exposes POST /agent/run. The route:
  - validates conversation id, message, and request size,
  - uses the same authoritative persistence path (MessageRepo) as other routes,
  - resolves the configured connection + adapter and proxies the request,
  - supports a deterministic simulation mode for local testing,
  - applies a timeout,
  - never leaks secrets or internal exception details.

Real AI requests use configured connections (see connection_routes.py). When
no connection is configured, the route returns a clear
`provider_not_configured` error — it NEVER silently falls back to a simulated
response when simulation is disabled.
"""
from __future__ import annotations

import json as _json
import logging
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Header, status
from pydantic import BaseModel, Field

from app.config import settings
from app.logging_config import log_backend, log_provider, log_error, is_debug_enabled
from app.db import connect
from app.repositories import ConversationRepo, MessageRepo
from app.connection_repos import ConnectionRepo, CredentialRepo, AgentDefaultsRepo
from app.adapters import resolve_adapter, AdapterError, CATEGORY_OK
from app.crypto import is_encryption_available
from app.diagnostics import DiagnosticsRepo, DiagnosticEvent
from app.retrieval import retrieve_context, render_context_block, DEFAULT_RETRIEVAL_BUDGET_CHARS
from app.agent_file_tools import (
    retrieve_project_context,
    render_project_context_block,
    DEFAULT_PROJECT_CONTEXT_BUDGET_CHARS,
    resolve_project_root,
    GEMINI_TOOL_DECLARATIONS,
    execute_tool_call,
    build_tool_instruction,
)


# Categories that should never be retried — retrying won't help.
_NON_RETRYABLE = frozenset({
    "auth_failed", "invalid_model", "invalid_endpoint",
    "quota_or_billing", "not_configured",
})
# Max retry attempts for transient errors (timeout, network, provider 5xx).
_MAX_RETRIES = 1


router = APIRouter(prefix="/agent", tags=["agent"])

logger = logging.getLogger("app.agent")


class AgentRunRequest(BaseModel):
    conversationId: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=32000)
    # connectionId selects a configured connection. When omitted, the agent
    # default connection is used.
    connectionId: Optional[str] = None
    model: str = Field(default="", max_length=120)
    providerId: str = Field(default="", max_length=60)
    systemPrompt: Optional[str] = Field(default=None, max_length=4000)
    allowSimulation: bool = False
    maxContextChars: int = Field(default=24000, ge=0, le=200000)
    maxHistoryMessages: int = Field(default=20, ge=0, le=200)
    # Phase 7: active project for memory/knowledge retrieval scoping.
    projectId: Optional[str] = Field(default=None, max_length=120)
    # Character budget for retrieved memory/knowledge context. 0 disables.
    maxRetrievalChars: int = Field(default=DEFAULT_RETRIEVAL_BUDGET_CHARS, ge=0, le=20000)
    # Phase 9: character budget for project-file context injection. 0 disables.
    maxProjectContextChars: int = Field(default=DEFAULT_PROJECT_CONTEXT_BUDGET_CHARS, ge=0, le=20000)


class AgentRunResponse(BaseModel):
    requestId: str
    conversationId: str
    status: str
    userMessage: Optional[dict] = None
    assistantMessage: Optional[dict] = None
    error: Optional[dict] = None
    meta: Optional[dict] = None
    retrieval: Optional[dict] = None
    projectContext: Optional[dict] = None
    toolsExecuted: Optional[list[dict]] = None
    startedAt: int
    finishedAt: int


def _build_runtime_system_block(
    *,
    selected_model: str,
    resolved_model: str,
    model_substituted: bool,
    adapter_id: str,
) -> str:
    """Build a system message with trusted runtime model metadata.

    This is injected AFTER the user-supplied system prompt (if any) and BEFORE
    retrieved context. It tells the assistant what model is actually running,
    so it never guesses its identity from general knowledge.
    """
    lines = [
        "[RUNTIME MODEL METADATA — verified for this request only]",
        f"selectedModel: {selected_model or '(none)'}",
        f"resolvedModel: {resolved_model or '(none)'}",
        f"adapter: {adapter_id}",
        f"modelSubstituted: {'true' if model_substituted else 'false'}",
        "providerReportedModel: (not yet known — determined after the request completes)",
        "",
        ("You are the AI assistant in a personal AI IDE. The model identity above "
         "is your verified runtime metadata for THIS request only. Follow these rules strictly:"),
        ("1. Never invent or guess your provider, model name, version, or capabilities. "
         "Do not claim to be Gemini 1.5, Gemini 2.5, GPT-4, or any other specific model "
         "based on your general knowledge."),
        ("2. When asked which model you are, state the resolvedModel from the metadata above. "
         "If the user selected a different model (selectedModel differs from resolvedModel), "
         "mention both."),
        ("3. Never declare a model nonexistent merely because you do not recognize its name. "
         "Model names like 'gemini-3.6-flash' may be real releases that postdate your training."),
        ("4. If providerReportedModel is '(not yet known)', clearly state that the exact "
         "executed model version cannot be independently verified from provider metadata."),
        ("5. Do not treat the selectedModel or toolbar label as proof of which model actually "
         "executed — only providerReportedModel (when available) confirms execution."),
        ("6. Be concise and accurate. Do not speculate about your architecture, parameter count, "
         "or training data unless the runtime metadata explicitly states it."),
    ]
    return "\n".join(lines)


def _simulated_response(message: str) -> str:
    """Deterministic simulated response for local testing. Clearly marked."""
    preview = message.strip().split("\n")[0][:80]
    return (
        "[Simulated response — no real model was contacted] "
        f"You said: {preview}. This is a deterministic development reply used to "
        "exercise the Agent lifecycle locally. Configure a real connection in "
        "Settings to use a real model."
    )


def _resolve_connection(conn, connection_id: Optional[str]) -> Optional[dict]:
    if connection_id:
        return ConnectionRepo.get(conn, connection_id)
    defaults = AgentDefaultsRepo.get(conn)
    if defaults["connectionId"]:
        return ConnectionRepo.get(conn, defaults["connectionId"])
    return None


def _safe_usage(usage: Optional[dict]) -> Optional[dict]:
    """Extract a safe, displayable subset of token-usage fields."""
    if not isinstance(usage, dict):
        return None
    out: dict[str, Any] = {}
    for key in ("promptTokenCount", "candidatesTokenCount", "totalTokenCount",
                "prompt_tokens", "completion_tokens", "total_tokens"):
        val = usage.get(key)
        if isinstance(val, (int, float)):
            out[key] = val
    return out if out else None


def _log_request_start(request_id: str, *, selected_connection_id: Optional[str],
                        selected_model: str, resolved_connection_id: Optional[str],
                        adapter_id: str, resolved_model: str, cred_id: Optional[str]):
    log_backend(
        "AI request started",
        request_id=request_id,
        selected_conn=selected_connection_id or "(default)",
        selected_model=selected_model or "(empty)",
        resolved_conn=resolved_connection_id or "(none)",
        adapter=adapter_id,
        resolved_model=resolved_model,
        cred_id=cred_id or "(none)",
    )


def _log_request_success(request_id: str, *, resolved_model: str,
                          provider_model: Optional[str], response_id: Optional[str],
                          status_code: int, duration_ms: int, usage: Optional[dict],
                          fallback: bool):
    log_provider(
        "Provider response received",
        request_id=request_id,
        model_sent=resolved_model,
        provider_model=provider_model or "(unreported)",
        response_id=response_id or "(none)",
        http=status_code,
        duration_ms=duration_ms,
        usage=usage or "(none)",
        fallback=str(fallback).lower(),
    )


def _log_request_failure(request_id: str, *, resolved_model: str,
                          error_code: str, error_msg: str, status_code: Optional[int],
                          duration_ms: int):
    log_error(
        "AI request failed",
        request_id=request_id,
        model_sent=resolved_model or "(none)",
        error_code=error_code,
        http=status_code if status_code is not None else "(none)",
        duration_ms=duration_ms,
        msg=error_msg[:200],
    )


def _chat_with_retry(adapter, base_url: str, secret: str, model: str,
                     messages: list[dict], *, timeout: float,
                     tools: Optional[list[dict]] = None):
    """Call adapter.chat with one bounded retry for transient errors only.

    Non-retryable errors (auth, invalid model, quota) are raised immediately.
    The model is never changed during retry — the same model is sent every time.
    """
    last_exc: Optional[Exception] = None
    for attempt in range(_MAX_RETRIES + 1):
        try:
            return adapter.chat(base_url, secret, model, messages, timeout=timeout, tools=tools)
        except AdapterError as exc:
            if exc.category in _NON_RETRYABLE or attempt >= _MAX_RETRIES:
                raise
            last_exc = exc
            log_provider(
                "Retryable adapter error, retrying",
                attempt=attempt + 1,
                category=exc.category,
            )
        except Exception as exc:
            if attempt >= _MAX_RETRIES:
                raise
            last_exc = exc
            log_provider(
                "Retryable error, retrying",
                attempt=attempt + 1,
                msg=str(exc)[:200],
            )
    raise last_exc  # type: ignore[misc]


@router.post("/run", response_model=AgentRunResponse)
def run_agent(body: AgentRunRequest, x_request_id: Optional[str] = Header(default=None, alias="X-Request-Id")):
    started = int(time.time() * 1000)
    # Prefer the frontend-supplied request id for log correlation. Fall back to
    # a server-generated uuid when the header is missing (e.g. direct API calls).
    request_id = (x_request_id or "").strip() or str(uuid.uuid4())
    log_backend(
        "Backend received AI request",
        request_id=request_id,
        endpoint="/agent/run",
        conversation_id=body.conversationId,
        selected_model=body.model or "(empty)",
        provider_id=body.providerId or "(none)",
        message_len=len(body.message),
    )

    with connect() as conn:
        conv = ConversationRepo.get(conn, body.conversationId)
        if not conv:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")

        # Persist the user message first (authoritative path).
        user_msg = MessageRepo.append(
            conn,
            conversation_id=body.conversationId,
            role="user",
            content=body.message,
        )

        connection = _resolve_connection(conn, body.connectionId)

        # No real connection configured.
        if not connection or not connection["enabled"]:
            # Even in simulation, retrieve context so the UI can show what would
            # be injected. Retrieval failure is swallowed.
            sim_retrieved = []
            try:
                sim_retrieved = retrieve_context(
                    conn,
                    message=body.message,
                    project_id=body.projectId,
                    budget_chars=body.maxRetrievalChars,
                )
            except Exception:  # noqa: BLE001
                sim_retrieved = []
            # Phase 9: retrieve project-file context (best-effort, swallowed).
            sim_project_items = []
            try:
                sim_project_items = retrieve_project_context(
                    body.projectId, body.message, body.maxProjectContextChars
                )
            except Exception:  # noqa: BLE001
                sim_project_items = []
            if body.allowSimulation:
                content = _simulated_response(body.message)
                assistant_msg = MessageRepo.append(
                    conn, conversation_id=body.conversationId, role="assistant", content=content
                )
                return AgentRunResponse(
                    requestId=request_id,
                    conversationId=body.conversationId,
                    status="completed",
                    userMessage=user_msg,
                    assistantMessage=assistant_msg,
                    meta={"providerId": "dev", "model": body.model or "dev-simulated", "simulated": True, "finishReason": "stop"},
                    retrieval={
                        "items": [r.to_dict() for r in sim_retrieved],
                        "chars": len(render_context_block(sim_retrieved)),
                    },
                    projectContext={
                        "items": [i.to_dict() for i in sim_project_items],
                        "chars": len(render_project_context_block(sim_project_items)),
                    },
                    startedAt=started,
                    finishedAt=int(time.time() * 1000),
                )
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={
                    "code": "provider_not_configured",
                    "message": (
                        "No AI connection is configured. Open Settings → AI Connections "
                        "to add a provider connection, or enable simulation to test the "
                        "Agent lifecycle locally."
                    ),
                },
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Connection exists but encryption is unavailable — fail safe.
        if not is_encryption_available():
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={
                    "code": "provider_unavailable",
                    "message": "Credential storage is not configured. Set PAIDE_ENC_KEY on the backend.",
                },
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Resolve the model to use. The frontend-selected model always wins
        # when present. Only when it is empty do we fall back to the connection's
        # defaultModel — and that fallback is explicitly recorded so it is never
        # silent. There is NO hardcoded model fallback here.
        selected_model = (body.model or "").strip()
        model_substituted = False
        if selected_model:
            model = selected_model
        elif connection["defaultModel"]:
            model = connection["defaultModel"]
            model_substituted = True
        else:
            _log_request_failure(
                request_id, resolved_model="(none)",
                error_code="invalid_request",
                error_msg="No model selected and connection has no default model.",
                status_code=None, duration_ms=0,
            )
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": "invalid_request", "message": "No model selected. Add a model to the connection in Settings."},
                meta={"requestId": request_id, "selectedModel": selected_model or None, "modelSubstituted": False},
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Load history (excluding the just-saved user message).
        history = MessageRepo.list(conn, body.conversationId)
        prior = [m for m in history if m["id"] != user_msg["id"]]

        if body.maxHistoryMessages > 0 and len(prior) > body.maxHistoryMessages:
            prior = prior[-body.maxHistoryMessages:]

        # Phase 7: retrieve relevant memory + knowledge scoped to the active
        # project (if any). Retrieval failure is swallowed — the run continues
        # without retrieved context. The block is framed as reference material,
        # never as instructions that could override the system prompt.
        retrieved = []
        retrieval_block = ""
        try:
            retrieved = retrieve_context(
                conn,
                message=body.message,
                project_id=body.projectId,
                budget_chars=body.maxRetrievalChars,
            )
            retrieval_block = render_context_block(retrieved)
        except Exception:  # noqa: BLE001 — retrieval must never fail the run
            retrieved = []
            retrieval_block = ""

        # Phase 9: retrieve project-file context scoped to the active project.
        # Best-effort — failure is swallowed so the run never fails due to file access.
        project_items = []
        project_block = ""
        try:
            project_items = retrieve_project_context(
                body.projectId, body.message, body.maxProjectContextChars
            )
            project_block = render_project_context_block(project_items)
        except Exception:  # noqa: BLE001
            project_items = []
            project_block = ""

        # Account for the retrieval + project blocks in the character budget so
        # they never starve history beyond the configured limit.
        retrieval_len = len(retrieval_block)
        project_len = len(project_block)
        if body.maxContextChars > 0:
            kept = []
            used = retrieval_len + project_len
            for m in reversed(prior):
                cost = len(m["content"]) + 1
                if used + cost > body.maxContextChars:
                    break
                kept.insert(0, m)
                used += cost
            prior = kept

        # Build the message list for the adapter.
        messages: list[dict] = []
        if body.systemPrompt:
            messages.append({"role": "system", "content": body.systemPrompt})
        # Inject trusted runtime model metadata as a system message so the
        # assistant never guesses its identity. This is scoped to THIS request
        # only and cannot leak from previous conversations.
        runtime_block = _build_runtime_system_block(
            selected_model=selected_model,
            resolved_model=model,
            model_substituted=model_substituted,
            adapter_id=connection["adapter"],
        )
        messages.append({"role": "system", "content": runtime_block})
        # Insert retrieved context as its own system message AFTER the real
        # system prompt, clearly labeled as reference material. This keeps it
        # separate from authoritative instructions and from conversation history.
        if retrieval_block:
            messages.append({"role": "system", "content": retrieval_block})
        if project_block:
            messages.append({"role": "system", "content": project_block})
        for m in prior:
            messages.append({"role": m["role"], "content": m["content"]})
        messages.append({"role": "user", "content": body.message})

        # Resolve the adapter.
        try:
            adapter = resolve_adapter(connection["adapter"])
        except ValueError:
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": "provider_unavailable", "message": "Unknown adapter for this connection."},
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Select a credential (primary enabled key, else failover).
        secret, cred = CredentialRepo.select_secret(conn, connection["id"])
        if not secret:
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": "provider_not_ready", "message": "No enabled API key for this connection."},
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Execute through the adapter.
        _log_request_start(
            request_id,
            selected_connection_id=body.connectionId,
            selected_model=selected_model,
            resolved_connection_id=connection["id"],
            adapter_id=connection["adapter"],
            resolved_model=model,
            cred_id=cred["id"] if cred else None,
        )
        DiagnosticsRepo.log(conn, DiagnosticEvent(
            event_type="ai_request_start", connection_id=connection["id"],
            provider_id=connection["adapter"], model=model,
            status="running", message="AI request started",
            details={
                "requestId": request_id,
                "selectedModel": selected_model or None,
                "resolvedConnectionId": connection["id"],
                "modelSubstituted": model_substituted,
                "credentialId": cred["id"] if cred else None,
            },
        ))
        req_t0 = time.time()
        timeout_s = float(settings.agent_timeout_seconds)
        exc_msg = ""
        exc_cat = ""
        exc_status: Optional[int] = None

        # Resolve the active project root for tool execution. Tools are
        # always sent to the model — when no project is open, only
        # create_project and get_env_template will succeed.
        project_root = None
        if body.projectId:
            project_root = resolve_project_root(body.projectId)
        tools_for_adapter = GEMINI_TOOL_DECLARATIONS
        tool_instruction = build_tool_instruction(project_root is not None)
        messages.append({"role": "system", "content": tool_instruction})

        try:
            result = _chat_with_retry(
                adapter, connection["baseUrl"], secret, model, messages,
                timeout=timeout_s, tools=tools_for_adapter,
            )
        except AdapterError as exc:
            req_dur = int((time.time() - req_t0) * 1000)
            exc_msg = str(exc)
            exc_cat = exc.category
            exc_status = exc.status_code
            _log_request_failure(
                request_id, resolved_model=model,
                error_code=exc_cat, error_msg=exc_msg,
                status_code=exc_status, duration_ms=req_dur,
            )
            DiagnosticsRepo.log(conn, DiagnosticEvent(
                event_type="ai_request_failure", connection_id=connection["id"],
                provider_id=connection["adapter"], model=model,
                status="error", duration_ms=req_dur,
                message=exc_msg,
                details={
                    "requestId": request_id,
                    "category": exc_cat,
                    "statusCode": exc_status,
                    "selectedModel": selected_model or None,
                    "modelSubstituted": model_substituted,
                },
            ))
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": exc_cat, "message": exc_msg},
                meta={
                    "providerId": connection["adapter"], "model": model, "simulated": False,
                    "requestId": request_id,
                    "selectedModel": selected_model or None,
                    "modelSubstituted": model_substituted,
                },
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )
        except Exception as exc:
            req_dur = int((time.time() - req_t0) * 1000)
            exc_msg = "The provider request failed unexpectedly."
            _log_request_failure(
                request_id, resolved_model=model,
                error_code="provider_failed",
                error_msg=exc_msg,
                status_code=None, duration_ms=req_dur,
            )
            log_error("Unexpected provider exception", exc=exc, request_id=request_id, model=model)
            DiagnosticsRepo.log(conn, DiagnosticEvent(
                event_type="ai_request_failure", connection_id=connection["id"],
                provider_id=connection["adapter"], model=model,
                status="error", duration_ms=req_dur,
                message=exc_msg,
                details={
                    "requestId": request_id,
                    "selectedModel": selected_model or None,
                    "modelSubstituted": model_substituted,
                },
            ))
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": "provider_failed", "message": exc_msg},
                meta={
                    "providerId": connection["adapter"], "model": model, "simulated": False,
                    "requestId": request_id,
                    "selectedModel": selected_model or None,
                    "modelSubstituted": model_substituted,
                },
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )
        req_dur = int((time.time() - req_t0) * 1000)
        provider_model = result.raw_meta.get("modelVersion") or result.raw_meta.get("model")
        provider_response_id = result.raw_meta.get("responseId")
        safe_usage = _safe_usage(result.usage)
        _log_request_success(
            request_id,
            resolved_model=model,
            provider_model=provider_model,
            response_id=provider_response_id,
            status_code=200,
            duration_ms=req_dur,
            usage=safe_usage,
            fallback=model_substituted,
        )
        success_details: dict = {
            "requestId": request_id,
            "selectedModel": selected_model or None,
            "modelSubstituted": model_substituted,
            "providerReportedModel": provider_model,
            "providerResponseId": provider_response_id,
            "usage": safe_usage,
        }
        if result.finish_reason:
            success_details["finishReason"] = result.finish_reason
        DiagnosticsRepo.log(conn, DiagnosticEvent(
            event_type="ai_request_success", connection_id=connection["id"],
            provider_id=connection["adapter"], model=model,
            status="ok", duration_ms=req_dur,
            message="AI request succeeded",
            details=success_details,
        ))

        # --- Tool execution loop ---
        # When tools are enabled and the model returns function calls, execute
        # them and feed the results back for up to MAX_TOOL_ROUNDS iterations.
        # The final response must be a text message.
        tools_executed: list[dict] = []
        MAX_TOOL_ROUNDS = 6
        current_messages = list(messages)
        # Accumulate any text the model produces alongside tool calls so it is
        # not lost — the model may explain what it is about to do.
        accumulated_text = result.content or ""
        # Track (tool_name, args) pairs already executed to avoid redundant calls.
        seen_tool_calls: set[tuple[str, str]] = set()

        for _round in range(MAX_TOOL_ROUNDS):
            if not result.tool_calls:
                break
            # If the model produced text alongside tool calls, preserve it.
            if result.content:
                accumulated_text += result.content
            for tc in result.tool_calls:
                call_key = (tc.name, _json.dumps(tc.args, sort_keys=True))
                if call_key in seen_tool_calls:
                    # Skip duplicate tool call — already executed with same args.
                    log_backend(
                        "Agent tool call skipped (duplicate)",
                        request_id=request_id,
                        tool=tc.name,
                    )
                    continue
                seen_tool_calls.add(call_key)
                tool_result = execute_tool_call(project_root, tc.name, tc.args)
                tools_executed.append({
                    "name": tc.name,
                    "args": tc.args,
                    "result": tool_result,
                })
                log_backend(
                    "Agent tool executed",
                    request_id=request_id,
                    tool=tc.name,
                    success="error" not in tool_result,
                )
                # Append the model's function call and the function response to
                # the conversation so the next round has full context.
                current_messages.append({
                    "role": "assistant",
                    "content": "",
                    "tool_calls": [{"name": tc.name, "args": tc.args}],
                })
                current_messages.append({
                    "role": "user",
                    "content": f"Tool '{tc.name}' result: {_json.dumps(tool_result)}",
                })
            # Re-call the adapter with the updated conversation.
            try:
                result = _chat_with_retry(
                    adapter, connection["baseUrl"], secret, model, current_messages,
                    timeout=timeout_s, tools=tools_for_adapter,
                )
            except (AdapterError, Exception) as exc:
                # If the follow-up call fails, keep the tool results and return
                # a best-effort response with the error.
                exc_cat = getattr(exc, "category", "provider_failed")
                exc_msg = str(getattr(exc, "message", exc)) or "Follow-up provider call failed."
                assistant_msg = MessageRepo.append(
                    conn,
                    conversation_id=body.conversationId,
                    role="assistant",
                    content=f"I executed tools but the follow-up response failed: {exc_msg}",
                )
                return AgentRunResponse(
                    requestId=request_id,
                    conversationId=body.conversationId,
                    status="completed",
                    userMessage=user_msg,
                    assistantMessage=assistant_msg,
                    toolsExecuted=tools_executed if tools_executed else None,
                    meta={
                        "providerId": connection["adapter"],
                        "connectionId": connection["id"],
                        "model": model, "simulated": False,
                        "requestId": request_id,
                        "selectedModel": selected_model or None,
                        "modelSubstituted": model_substituted,
                        "providerReportedModel": provider_model,
                        "providerResponseId": provider_response_id,
                        "providerActualModelConfirmed": bool(provider_model),
                        "error": exc_msg,
                    },
                    retrieval={"items": [r.to_dict() for r in retrieved], "chars": retrieval_len},
                    projectContext={"items": [i.to_dict() for i in project_items], "chars": project_len},
                    startedAt=started,
                    finishedAt=int(time.time() * 1000),
                )
        # After the loop, result should be a text response.
        final_content = result.content or ""
        if accumulated_text and not final_content:
            final_content = accumulated_text
        if not final_content and tools_executed:
            # The model only produced tool calls with no final summary — build one.
            summary_parts = [f"I executed {len(tools_executed)} tool operation(s):"]
            for t in tools_executed:
                status_txt = "ok" if "error" not in t["result"] else "failed"
                summary_parts.append(f"- {t['name']}: {status_txt}")
            final_content = "\n".join(summary_parts)

        # Persist the assistant message (authoritative path).
        assistant_msg = MessageRepo.append(
            conn,
            conversation_id=body.conversationId,
            role="assistant",
            content=final_content,
        )

        # Mark the connection status based on success.
        ConnectionRepo.update(conn, connection["id"], status="connected")

        return AgentRunResponse(
            requestId=request_id,
            conversationId=body.conversationId,
            status="completed",
            userMessage=user_msg,
            assistantMessage=assistant_msg,
            toolsExecuted=tools_executed if tools_executed else None,
            meta={
                "providerId": connection["adapter"],
                "connectionId": connection["id"],
                "model": model,
                "simulated": False,
                "finishReason": result.finish_reason,
                "usage": _safe_usage(result.usage),
                "requestId": request_id,
                "selectedModel": selected_model or None,
                "modelSubstituted": model_substituted,
                "providerReportedModel": provider_model,
                "providerResponseId": provider_response_id,
                "providerActualModelConfirmed": bool(provider_model),
            },
            retrieval={
                "items": [r.to_dict() for r in retrieved],
                "chars": retrieval_len,
            },
            projectContext={
                "items": [i.to_dict() for i in project_items],
                "chars": project_len,
            },
            startedAt=started,
            finishedAt=int(time.time() * 1000),
        )


@router.post("/cancel/{cid}", status_code=status.HTTP_202_ACCEPTED)
def cancel_agent(cid: str):
    """Cancel is best-effort. Synchronous requests are handled client-side."""
    return {"conversationId": cid, "cancelled": False, "note": "Cancellation of synchronous runs is handled client-side via AbortSignal."}
