"""Streaming agent execution route (SSE).

Exposes POST /agent/run/stream. The route streams text deltas, tool execution
events, and file-change events to the frontend as they happen, so the UI can
show progressive output instead of waiting for the full response.

Event protocol (Server-Sent Events):
  event: start         data: {requestId, conversationId, userMessage}
  event: delta         data: {text}
  event: tool_start    data: {name, args}
  event: tool_result   data: {name, result}
  event: file_change   data: {path, action}   # action: created|modified|deleted|renamed
  event: activity      data: {status, message, fileName?}
  event: done          data: {assistantMessage, meta, toolsExecuted?}
  event: error         data: {code, message}

All operations reuse the same validation, security, and persistence patterns
as the non-streaming /agent/run endpoint. The user message is persisted first;
the assistant message is persisted only once at the end.
"""
from __future__ import annotations

import logging
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Header, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.config import settings
from app.logging_config import log_backend, log_provider, log_error
from app.db import connect
from app.repositories import ConversationRepo, MessageRepo
from app.connection_repos import ConnectionRepo, CredentialRepo, AgentDefaultsRepo
from app.adapters import resolve_adapter, AdapterError, StreamChunk
from app.crypto import is_encryption_available
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
from app.agent_routes import (
    AgentRunRequest,
    _resolve_connection,
    _safe_usage,
    _build_runtime_system_block,
    _simulated_response,
    _log_request_start,
    _log_request_success,
    _log_request_failure,
    _NON_RETRYABLE,
    _MAX_RETRIES,
)

import json as _json

router = APIRouter(prefix="/agent", tags=["agent-stream"])
logger = logging.getLogger("app.agent_stream")

MAX_TOOL_ROUNDS = 20


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {_json.dumps(data, ensure_ascii=False)}\n\n"


def _build_messages(
    body: AgentRunRequest,
    conn,
    user_msg: dict,
) -> tuple[list[dict], Optional[dict], str, bool, list, str, int, list, int, Optional[dict]]:
    """Build the message list, mirroring the non-streaming route logic.
    Returns (messages, connection, model, model_substituted, retrieved,
    retrieval_block, retrieval_len, project_items, project_len, error_detail).
    error_detail is set if a pre-execution error occurred (dict with code+message).
    """
    connection = _resolve_connection(conn, body.connectionId)
    if not connection or not connection["enabled"]:
        if body.allowSimulation:
            # Simulation path handled by caller separately.
            return [], None, "", False, [], "", 0, [], 0, None
        return [], None, "", False, [], "", 0, [], 0, {
            "code": "provider_not_configured",
            "message": "No AI connection is configured. Open Settings to add one, or enable simulation.",
        }

    if not is_encryption_available():
        return [], connection, "", False, [], "", 0, [], 0, {
            "code": "provider_unavailable",
            "message": "Credential storage is not configured. Set PAIDE_ENC_KEY on the backend.",
        }

    selected_model = (body.model or "").strip()
    model_substituted = False
    if selected_model:
        model = selected_model
    elif connection["defaultModel"]:
        model = connection["defaultModel"]
        model_substituted = True
    else:
        return [], connection, "", False, [], "", 0, [], 0, {
            "code": "invalid_request",
            "message": "No model selected. Add a model to the connection in Settings.",
        }

    history = MessageRepo.list(conn, body.conversationId)
    prior = [m for m in history if m["id"] != user_msg["id"]]
    if body.maxHistoryMessages > 0 and len(prior) > body.maxHistoryMessages:
        prior = prior[-body.maxHistoryMessages:]

    retrieved = []
    retrieval_block = ""
    try:
        retrieved = retrieve_context(conn, message=body.message, project_id=body.projectId, budget_chars=body.maxRetrievalChars)
        retrieval_block = render_context_block(retrieved)
    except Exception:
        retrieved = []
        retrieval_block = ""

    project_items = []
    project_block = ""
    try:
        project_items = retrieve_project_context(body.projectId, body.message, body.maxProjectContextChars)
        project_block = render_project_context_block(project_items)
    except Exception:
        project_items = []
        project_block = ""

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

    messages: list[dict] = []
    if body.systemPrompt:
        messages.append({"role": "system", "content": body.systemPrompt})
    runtime_block = _build_runtime_system_block(
        selected_model=selected_model, resolved_model=model,
        model_substituted=model_substituted, adapter_id=connection["adapter"],
    )
    messages.append({"role": "system", "content": runtime_block})
    if retrieval_block:
        messages.append({"role": "system", "content": retrieval_block})
    if project_block:
        messages.append({"role": "system", "content": project_block})
    for m in prior:
        messages.append({"role": m["role"], "content": m["content"]})
    messages.append({"role": "user", "content": body.message})

    return (messages, connection, model, model_substituted, retrieved,
            retrieval_block, retrieval_len, project_items, project_len, None)


def _detect_file_changes(tool_name: str, tool_args: dict, tool_result: dict) -> Optional[dict]:
    """Map a tool execution to a file_change event."""
    if "error" in tool_result:
        return None
    if tool_name == "write_file":
        path = tool_result.get("path") or tool_args.get("path", "")
        created = tool_result.get("created", False)
        return {"path": path, "action": "created" if created else "modified"}
    if tool_name == "create_directory":
        return {"path": tool_result.get("path", ""), "action": "created"}
    if tool_name == "delete_path":
        return {"path": tool_result.get("path", ""), "action": "deleted"}
    if tool_name == "rename_path":
        return {"path": tool_result.get("toPath", ""), "action": "renamed",
                "oldPath": tool_result.get("fromPath", "")}
    if tool_name == "create_project":
        files = tool_result.get("fileList", [])
        if files:
            return {"path": files[0], "action": "created",
                    "projectCreated": True,
                    "workspacePath": tool_result.get("workspacePath", ""),
                    "projectId": tool_result.get("projectId", ""),
                    "files": files}
        return None
    return None


def _activity_for_tool(tool_name: str) -> str:
    mapping = {
        "list_files": "Exploring project",
        "read_file": "Reading file",
        "write_file": "Writing file",
        "create_directory": "Creating directory",
        "search_files": "Searching project",
        "rename_path": "Renaming file",
        "delete_path": "Deleting file",
        "run_command": "Running command",
        "detect_runtime": "Detecting runtime",
        "install_deps": "Installing dependencies",
        "create_project": "Creating project",
        "get_env_template": "Reading env template",
    }
    return mapping.get(tool_name, "Executing tool")


@router.post("/run/stream")
async def stream_agent(body: AgentRunRequest, x_request_id: Optional[str] = Header(default=None, alias="X-Request-Id")):
    started = int(time.time() * 1000)
    request_id = (x_request_id or "").strip() or str(uuid.uuid4())
    log_backend("Backend received streaming AI request", request_id=request_id, conversation_id=body.conversationId)

    def generate():
        with connect() as conn:
            conv = ConversationRepo.get(conn, body.conversationId)
            if not conv:
                yield _sse("error", {"code": "not_found", "message": "Conversation not found"})
                return

            user_msg = MessageRepo.append(
                conn, conversation_id=body.conversationId, role="user", content=body.message,
            )
            yield _sse("start", {"requestId": request_id, "conversationId": body.conversationId, "userMessage": user_msg})

            messages, connection, model, model_substituted, retrieved, \
                retrieval_block, retrieval_len, project_items, project_len, pre_error = \
                _build_messages(body, conn, user_msg)

            if pre_error:
                yield _sse("error", pre_error)
                return

            if connection is None:
                # Simulation mode
                content = _simulated_response(body.message)
                yield _sse("activity", {"status": "simulating", "message": "Generating simulated response"})
                assistant_msg = MessageRepo.append(
                    conn, conversation_id=body.conversationId, role="assistant", content=content,
                )
                yield _sse("done", {
                    "assistantMessage": assistant_msg,
                    "meta": {"providerId": "dev", "model": body.model or "dev-simulated", "simulated": True, "finishReason": "stop"},
                    "toolsExecuted": None,
                })
                return

            try:
                adapter = resolve_adapter(connection["adapter"])
            except ValueError:
                yield _sse("error", {"code": "provider_unavailable", "message": "Unknown adapter for this connection."})
                return

            secret, cred = CredentialRepo.select_secret(conn, connection["id"])
            if not secret:
                yield _sse("error", {"code": "provider_not_ready", "message": "No enabled API key for this connection."})
                return

            _log_request_start(
                request_id, selected_connection_id=body.connectionId, selected_model=(body.model or ""),
                resolved_connection_id=connection["id"], adapter_id=connection["adapter"],
                resolved_model=model, cred_id=cred["id"] if cred else None,
            )

            timeout_s = float(settings.agent_timeout_seconds)
            project_root = None
            if body.projectId:
                project_root = resolve_project_root(body.projectId)
            # Always send tools to the model. When no project is open, only
            # create_project and get_env_template will succeed; the others
            # return a helpful error. This lets the agent scaffold new
            # projects from an empty workspace.
            tools_for_adapter = GEMINI_TOOL_DECLARATIONS
            messages.append({"role": "system", "content": build_tool_instruction(project_root is not None)})

            yield _sse("activity", {"status": "thinking", "message": "AI is analyzing your request"})

            tools_executed: list[dict] = []
            full_text = ""
            provider_model: Optional[str] = None
            finish_reason: Optional[str] = None
            usage: Optional[dict] = None
            seen_tool_calls: set[tuple[str, str]] = set()

            current_messages = list(messages)
            req_t0 = time.time()

            for round_idx in range(MAX_TOOL_ROUNDS + 1):
                try:
                    accumulated_text = ""
                    accumulated_tool_calls: list = []
                    round_finish = None
                    round_usage = None
                    for chunk in adapter.chat_stream(
                        connection["baseUrl"], secret, model, current_messages,
                        timeout=timeout_s, tools=tools_for_adapter,
                    ):
                        if chunk.delta:
                            accumulated_text += chunk.delta
                            yield _sse("delta", {"text": chunk.delta})
                        if chunk.tool_calls:
                            accumulated_tool_calls.extend(chunk.tool_calls)
                        if chunk.finish_reason:
                            round_finish = chunk.finish_reason
                        if chunk.usage:
                            round_usage = chunk.usage
                    finish_reason = round_finish or finish_reason
                    usage = round_usage or usage
                except AdapterError as exc:
                    req_dur = int((time.time() - req_t0) * 1000)
                    _log_request_failure(request_id, resolved_model=model, error_code=exc.category,
                                         error_msg=str(exc), status_code=exc.status_code, duration_ms=req_dur)
                    yield _sse("error", {"code": exc.category, "message": str(exc)})
                    return
                except Exception as exc:
                    req_dur = int((time.time() - req_t0) * 1000)
                    _log_request_failure(request_id, resolved_model=model, error_code="provider_failed",
                                         error_msg="The provider request failed unexpectedly.", status_code=None, duration_ms=req_dur)
                    log_error("Streaming provider exception", exc=exc, request_id=request_id)
                    yield _sse("error", {"code": "provider_failed", "message": "The provider request failed unexpectedly."})
                    return

                full_text += accumulated_text

                # If no tool calls, we're done. Tool execution is allowed
                # even without a project root (create_project, get_env_template).
                if not accumulated_tool_calls:
                    break

                # Execute tools and feed results back.
                for tc in accumulated_tool_calls:
                    call_key = (tc.name, _json.dumps(tc.args, sort_keys=True))
                    if call_key in seen_tool_calls:
                        log_backend("Agent tool call skipped (duplicate)",
                                    request_id=request_id, tool=tc.name)
                        continue
                    seen_tool_calls.add(call_key)
                    yield _sse("tool_start", {"name": tc.name, "args": tc.args})
                    yield _sse("activity", {"status": "tool", "message": _activity_for_tool(tc.name),
                                            "fileName": tc.args.get("path") if isinstance(tc.args, dict) else None})
                    tool_result = execute_tool_call(project_root, tc.name, tc.args)
                    tools_executed.append({"name": tc.name, "args": tc.args, "result": tool_result})
                    yield _sse("tool_result", {"name": tc.name, "result": tool_result})

                    fc = _detect_file_changes(tc.name, tc.args, tool_result)
                    if fc:
                        if fc.get("projectCreated"):
                            yield _sse("project_created", {
                                "projectId": fc.get("projectId", ""),
                                "workspacePath": fc.get("workspacePath", ""),
                                "files": fc.get("files", []),
                            })
                            yield _sse("activity", {"status": "saved", "message": f"Created project: {fc.get('workspacePath', '')}",
                                                    "fileName": fc.get("workspacePath", "")})
                            if fc.get("projectId"):
                                new_root = resolve_project_root(fc["projectId"])
                                if new_root:
                                    project_root = new_root
                                    current_messages.append({
                                        "role": "system",
                                        "content": (
                                            "A project has been created and is now the active project. "
                                            "You now have full access to file tools (list_files, read_file, write_file, etc.), "
                                            "run_command, detect_runtime, and install_deps. "
                                            f"The project root is: {fc.get('workspacePath', '')}. "
                                            "Continue with the next steps: list files, install dependencies, or write additional files as needed. "
                                            "Do NOT stop after creating the project — complete all requested work."
                                        ),
                                    })
                        else:
                            yield _sse("file_change", fc)
                            yield _sse("activity", {"status": "saved", "message": f"{'Created' if fc['action'] == 'created' else 'Saved'} {fc['path']}",
                                                    "fileName": fc["path"]})

                    current_messages.append({
                        "role": "assistant", "content": "",
                        "tool_calls": [{"name": tc.name, "args": tc.args}],
                    })
                    current_messages.append({
                        "role": "user", "content": "",
                        "tool_result": {"name": tc.name, "result": tool_result},
                    })

                yield _sse("activity", {"status": "continuing", "message": "AI is continuing after tool execution"})

            req_dur = int((time.time() - req_t0) * 1000)

            # If we hit the round limit with tools still running, report it.
            round_limit_hit = accumulated_tool_calls and round_idx >= MAX_TOOL_ROUNDS

            # If tools ran but no final text, build a summary.
            if not full_text and tools_executed:
                summary_parts = [f"I executed {len(tools_executed)} tool operation(s):"]
                for t in tools_executed:
                    status_txt = "ok" if "error" not in t["result"] else "failed"
                    summary_parts.append(f"- {t['name']}: {status_txt}")
                if round_limit_hit:
                    summary_parts.append("")
                    summary_parts.append(f"NOTE: Reached the maximum of {MAX_TOOL_ROUNDS} tool rounds. The task may not be fully complete.")
                full_text = "\n".join(summary_parts)

            if not full_text and not tools_executed:
                full_text = "(No response generated.)"

            # Persist the assistant message once.
            assistant_msg = MessageRepo.append(
                conn, conversation_id=body.conversationId, role="assistant", content=full_text,
            )
            ConnectionRepo.update(conn, connection["id"], status="connected")

            safe_usage = _safe_usage(usage)
            _log_request_success(request_id, resolved_model=model, provider_model=provider_model,
                                 response_id=None, status_code=200, duration_ms=req_dur,
                                 usage=safe_usage, fallback=model_substituted)

            yield _sse("activity", {"status": "completed", "message": "Response complete"})
            yield _sse("done", {
                "assistantMessage": assistant_msg,
                "meta": {
                    "providerId": connection["adapter"],
                    "connectionId": connection["id"],
                    "model": model,
                    "simulated": False,
                    "finishReason": finish_reason,
                    "usage": safe_usage,
                    "requestId": request_id,
                    "selectedModel": (body.model or "") or None,
                    "modelSubstituted": model_substituted,
                },
                "toolsExecuted": tools_executed if tools_executed else None,
            })

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
