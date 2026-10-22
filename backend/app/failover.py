"""Failover engine for model profiles.

Given a resolved list of candidates (from profile_repos.resolve_candidates),
the engine tries each one in priority order. When a candidate fails with a
retryable error (rate limit, timeout, provider error, network error), it
moves to the next candidate. Non-retryable errors (auth, invalid model,
quota/billing) also trigger failover — only content-generation errors after
a successful stream start are considered non-retryable.

The engine is designed to be called from agent_stream_routes during SSE
streaming. It yields structured events so the caller can forward them to the
frontend, letting the user see which candidates were tried and why.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Optional

from app.adapters import resolve_adapter, AdapterError
from app.connection_repos import CredentialRepo
from app.db import connect
from app.diagnostics import DiagnosticsRepo, DiagnosticEvent
from app.logging_config import log_provider, log_error
from app.profile_repos import resolve_candidates, DefaultProfileRepo, ProjectProfileAssignmentRepo


def _build_messages_for_chat(prompt: str, system_prompt: Optional[str] = None) -> list[dict]:
    """Build a simple message list from a combined prompt string."""
    messages: list[dict] = []
    if system_prompt:
        messages.append({"role": "system", "content": system_prompt})
    messages.append({"role": "user", "content": prompt})
    return messages


@dataclass
class FailoverEvent:
    """A single event in the failover lifecycle."""
    type: str  # 'attempt' | 'success' | 'failover' | 'exhausted'
    candidate_index: int
    connection_id: str
    model_id: str
    connection_name: str = ""
    category: Optional[str] = None
    message: str = ""
    duration_ms: Optional[int] = None


@dataclass
class FailoverResult:
    """The outcome of a failover run."""
    success: bool
    events: list[FailoverEvent] = field(default_factory=list)
    used_connection_id: Optional[str] = None
    used_model_id: Optional[str] = None
    content: str = ""
    error_message: str = ""
    usage: Optional[dict] = None
    finish_reason: Optional[str] = None


def _is_retryable(category: str) -> bool:
    """Whether a failure category warrants trying the next candidate."""
    return category in (
        "rate_limited",
        "timeout",
        "network_error",
        "provider_error",
        "auth_failed",
        "quota_or_billing",
        "invalid_model",
        "invalid_endpoint",
    )


def resolve_profile_for_project(conn, project_id: Optional[str]) -> Optional[str]:
    """Determine which profile to use for a given project.

    Priority: project assignment > default profile > None (no profile).
    """
    if project_id:
        assignment = ProjectProfileAssignmentRepo.get(conn, project_id)
        if assignment and assignment["profileEnabled"]:
            return assignment["profileId"]
    return DefaultProfileRepo.get(conn)


def run_with_failover(
    *,
    profile_id: str,
    prompt: str,
    system_prompt: Optional[str] = None,
    max_tokens: int = 4096,
    temperature: float = 0.7,
    project_id: Optional[str] = None,
) -> FailoverResult:
    """Try each candidate in a profile until one succeeds.

    This is the non-streaming variant. For streaming, use
    `stream_with_failover` which yields events as they happen.
    """
    result = FailoverResult(success=False)
    with connect() as conn:
        candidates = resolve_candidates(conn, profile_id)
        if not candidates:
            result.error_message = "No usable candidates in this profile."
            return result

        for idx, cand in enumerate(candidates):
            event = FailoverEvent(
                type="attempt",
                candidate_index=idx,
                connection_id=cand["connectionId"],
                model_id=cand["modelId"],
                connection_name=cand["displayName"],
            )
            result.events.append(event)
            t0 = time.time()
            try:
                secret, _ = CredentialRepo.select_secret(conn, cand["connectionId"])
                if not secret:
                    event.type = "failover"
                    event.category = "auth_failed"
                    event.message = "No enabled API key for this connection."
                    event.duration_ms = int((time.time() - t0) * 1000)
                    continue

                adapter = resolve_adapter(cand["adapter"])
                chat_messages = _build_messages_for_chat(prompt, system_prompt)
                response = adapter.chat(
                    base_url=cand["baseUrl"],
                    api_key=secret,
                    model=cand["modelId"],
                    messages=chat_messages,
                    timeout=30.0,
                )
                event.type = "success"
                event.duration_ms = int((time.time() - t0) * 1000)
                result.success = True
                result.used_connection_id = cand["connectionId"]
                result.used_model_id = cand["modelId"]
                result.content = response.content or ""
                result.usage = getattr(response, "usage", None)
                result.finish_reason = getattr(response, "finish_reason", None)
                DiagnosticsRepo.log(conn, DiagnosticEvent(
                    event_type="failover_success",
                    connection_id=cand["connectionId"],
                    provider_id=cand["adapter"],
                    model=cand["modelId"],
                    status="ok",
                    duration_ms=event.duration_ms,
                    message=f"Succeeded on candidate {idx + 1}",
                    details={"profile_id": profile_id, "candidate_index": idx},
                ))
                return result
            except AdapterError as exc:
                event.type = "failover"
                event.category = exc.category
                event.message = exc.message
                event.duration_ms = int((time.time() - t0) * 1000)
                log_error(
                    "Failover candidate failed",
                    connection_id=cand["connectionId"],
                    adapter=cand["adapter"],
                    model=cand["modelId"],
                    category=exc.category,
                    duration_ms=event.duration_ms,
                )
                DiagnosticsRepo.log(conn, DiagnosticEvent(
                    event_type="failover_candidate_failed",
                    connection_id=cand["connectionId"],
                    provider_id=cand["adapter"],
                    model=cand["modelId"],
                    status="error",
                    duration_ms=event.duration_ms,
                    message=exc.message,
                    details={"profile_id": profile_id, "candidate_index": idx, "category": exc.category},
                ))
                if not _is_retryable(exc.category):
                    result.error_message = exc.message
                    return result
                continue
            except Exception as exc:
                event.type = "failover"
                event.category = "network_error"
                event.message = str(exc)
                event.duration_ms = int((time.time() - t0) * 1000)
                log_error(
                    "Failover candidate unexpected error",
                    connection_id=cand["connectionId"],
                    adapter=cand.get("adapter", "unknown"),
                    model=cand["modelId"],
                    category="network_error",
                    duration_ms=event.duration_ms,
                )
                continue

    result.error_message = "All candidates exhausted."
    result.events.append(FailoverEvent(
        type="exhausted",
        candidate_index=len(candidates),
        connection_id="",
        model_id="",
        message="All fallback candidates failed.",
    ))
    return result
