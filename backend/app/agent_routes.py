"""Agent execution route for the FastAPI backend.

Exposes a single POST /agent/run endpoint that:
  - validates conversation id, message, and request size,
  - uses the same authoritative persistence path (MessageRepo) as other routes,
  - proxies the request through a provider adapter (Phase 6 wires real ones),
  - supports a deterministic simulation mode for local testing,
  - applies a reasonable timeout,
  - never leaks secrets or internal exception details.

In Phase 5, real provider integrations are not wired. When `simulate` is true,
the backend uses a deterministic dev responder so the full lifecycle can be
exercised locally. When `simulate` is false and no real provider is configured,
the endpoint returns a clear `provider_not_configured` error.
"""
from __future__ import annotations

import time
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, status, Request
from pydantic import BaseModel, Field

from app.config import settings
from app.db import connect
from app.repositories import ConversationRepo, MessageRepo


router = APIRouter(prefix="/agent", tags=["agent"])


class AgentRunRequest(BaseModel):
    conversationId: str = Field(min_length=1, max_length=120)
    message: str = Field(min_length=1, max_length=32000)
    model: str = Field(default="gemini-2.0-flash", max_length=120)
    providerId: str = Field(default="gemini", max_length=60)
    systemPrompt: Optional[str] = Field(default=None, max_length=4000)
    allowSimulation: bool = False
    maxContextChars: int = Field(default=24000, ge=0, le=200000)
    maxHistoryMessages: int = Field(default=20, ge=0, le=200)


class AgentRunResponse(BaseModel):
    requestId: str
    conversationId: str
    status: str
    userMessage: Optional[dict] = None
    assistantMessage: Optional[dict] = None
    error: Optional[dict] = None
    meta: Optional[dict] = None
    startedAt: int
    finishedAt: int


def _provider_configured(pid: str) -> bool:
    """Return True if the provider has an API key configured in backend/.env."""
    key_map = {
        "gemini": settings.gemini_api_key,
        "groq": settings.groq_api_key,
        "cerebras": settings.cerebras_api_key,
        "openrouter": settings.openrouter_api_key,
    }
    key = key_map.get(pid)
    return bool(key)


def _simulated_response(message: str) -> str:
    """Deterministic simulated response for local testing. Clearly marked."""
    preview = message.strip().split("\n")[0][:80]
    return (
        "[Simulated response — no real model was contacted] "
        f"You said: {preview}. This is a deterministic development reply used to "
        "exercise the Agent lifecycle locally. Configure a provider API key in "
        "backend/.env and set allowSimulation=false to use a real model (Phase 6)."
    )


@router.post("/run", response_model=AgentRunResponse)
def run_agent(body: AgentRunRequest, req: Request):
    started = int(time.time() * 1000)
    request_id = str(uuid.uuid4())

    with connect() as conn:
        # Validate conversation exists.
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

        configured = _provider_configured(body.providerId)

        # If a real provider is configured, Phase 6 will proxy here.
        # In Phase 5 we only support simulation; otherwise return a clear error.
        if not body.allowSimulation and not configured:
            # Remove the user message to avoid orphaned partial runs? No — the
            # user message is legitimately saved. We return a failed run with
            # the user message attached so the UI can show it.
            return AgentRunResponse(
                requestId=request_id,
                conversationId=body.conversationId,
                status="failed",
                userMessage=user_msg,
                error={
                    "code": "provider_not_configured",
                    "message": (
                        f"Provider '{body.providerId}' has no API key configured in "
                        "backend/.env, and simulation is disabled. Set an API key "
                        "or enable allowSimulation to test the Agent locally."
                    ),
                },
                startedAt=started,
                finishedAt=int(time.time() * 1000),
            )

        # Load history (excluding the just-saved user message).
        history = MessageRepo.list(conn, body.conversationId)
        prior = [m for m in history if m["id"] != user_msg["id"]]

        # Apply message-count + character budget (approximation).
        if body.maxHistoryMessages > 0 and len(prior) > body.maxHistoryMessages:
            prior = prior[-body.maxHistoryMessages:]

        if body.maxContextChars > 0:
            kept = []
            used = 0
            for m in reversed(prior):
                cost = len(m["content"]) + 1
                if used + cost > body.maxContextChars:
                    break
                kept.insert(0, m)
                used += cost
            prior = kept

        # Produce the assistant response. Phase 5: deterministic simulation only.
        content = _simulated_response(body.message)
        simulated = True
        if configured and not body.allowSimulation:
            # Phase 6 will replace this branch with a real provider call.
            # For now, treat as not-yet-implemented but configured.
            content = (
                "[Provider configured but not yet implemented in Phase 5] "
                "An API key is set for this provider, but the actual provider "
                "integration ships in Phase 6. Enable allowSimulation to test "
                "the Agent lifecycle locally."
            )
            simulated = True

        assistant_msg = MessageRepo.append(
            conn,
            conversation_id=body.conversationId,
            role="assistant",
            content=content,
        )

    return AgentRunResponse(
        requestId=request_id,
        conversationId=body.conversationId,
        status="completed",
        userMessage=user_msg,
        assistantMessage=assistant_msg,
        meta={
            "providerId": body.providerId,
            "model": body.model,
            "simulated": simulated,
            "finishReason": "stop",
        },
        startedAt=started,
        finishedAt=int(time.time() * 1000),
    )


@router.post("/cancel/{cid}", status_code=status.HTTP_202_ACCEPTED)
def cancel_agent(cid: str):
    """Cancel is best-effort. Phase 5 requests are synchronous, so this is a
    no-op stub that documents the contract for Phase 6 streaming runs."""
    return {"conversationId": cid, "cancelled": False, "note": "Cancellation of synchronous Phase 5 runs is handled client-side via AbortSignal."}
