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

import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.db import connect
from app.repositories import ConversationRepo, MessageRepo
from app.connection_repos import ConnectionRepo, CredentialRepo, AgentDefaultsRepo
from app.adapters import resolve_adapter, AdapterError, CATEGORY_OK
from app.crypto import is_encryption_available
from app.retrieval import retrieve_context, render_context_block, DEFAULT_RETRIEVAL_BUDGET_CHARS


router = APIRouter(prefix="/agent", tags=["agent"])


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


class AgentRunResponse(BaseModel):
    requestId: str
    conversationId: str
    status: str
    userMessage: Optional[dict] = None
    assistantMessage: Optional[dict] = None
    error: Optional[dict] = None
    meta: Optional[dict] = None
    retrieval: Optional[dict] = None
    startedAt: int
    finishedAt: int


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


@router.post("/run", response_model=AgentRunResponse)
def run_agent(body: AgentRunRequest):
    started = int(time.time() * 1000)
    request_id = str(uuid.uuid4())

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

        # Resolve the model to use.
        model = body.model or connection["defaultModel"] or ""
        if not model:
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": "invalid_request", "message": "No model selected. Add a model to the connection in Settings."},
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

        # Account for the retrieval block in the character budget so it never
        # starves history beyond the configured limit.
        retrieval_len = len(retrieval_block)
        if body.maxContextChars > 0:
            kept = []
            used = retrieval_len
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
        # Insert retrieved context as its own system message AFTER the real
        # system prompt, clearly labeled as reference material. This keeps it
        # separate from authoritative instructions and from conversation history.
        if retrieval_block:
            messages.append({"role": "system", "content": retrieval_block})
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
        secret, _cred = CredentialRepo.select_secret(conn, connection["id"])
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
        try:
            result = adapter.chat(
                connection["baseUrl"],
                secret,
                model,
                messages,
                timeout=30.0,
            )
        except AdapterError as exc:
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": exc.category, "message": exc.message},
                meta={"providerId": connection["adapter"], "model": model, "simulated": False},
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )
        except Exception:
            # Never leak internal exception details.
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={"code": "provider_failed", "message": "The provider request failed unexpectedly."},
                meta={"providerId": connection["adapter"], "model": model, "simulated": False},
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Persist the assistant message (authoritative path).
        assistant_msg = MessageRepo.append(
            conn,
            conversation_id=body.conversationId,
            role="assistant",
            content=result.content,
        )

        # Mark the connection status based on success.
        ConnectionRepo.update(conn, connection["id"], status="connected")

        return AgentRunResponse(
            requestId=request_id,
            conversationId=body.conversationId,
            status="completed",
            userMessage=user_msg,
            assistantMessage=assistant_msg,
            meta={
                "providerId": connection["adapter"],
                "connectionId": connection["id"],
                "model": model,
                "simulated": False,
                "finishReason": result.finish_reason,
                "usage": result.usage,
            },
            retrieval={
                "items": [r.to_dict() for r in retrieved],
                "chars": retrieval_len,
            },
            startedAt=started,
            finishedAt=int(time.time() * 1000),
        )


@router.post("/cancel/{cid}", status_code=status.HTTP_202_ACCEPTED)
def cancel_agent(cid: str):
    """Cancel is best-effort. Synchronous requests are handled client-side."""
    return {"conversationId": cid, "cancelled": False, "note": "Cancellation of synchronous runs is handled client-side via AbortSignal."}
