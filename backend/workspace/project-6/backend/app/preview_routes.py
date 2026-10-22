"""Preview server management routes.

Provides a thin orchestration layer on top of the existing ProcessManager
for starting/stopping/querying dev servers used by the Preview tab.

  * POST /preview/start/{project_id}  — detect runtime, start dev server
  * POST /preview/stop/{project_id}   — stop the active dev server
  * GET  /preview/status/{project_id} — current preview status (URL, state, logs)
  * GET  /preview/logs/{project_id}   — recent stdout/stderr from the preview session

The preview session is tracked as a regular exec session with kind="run"
and longRunning=True. We store the session id per-project so the frontend
can poll status without searching through all sessions.
"""
from __future__ import annotations

import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.db import connect
from app.execution import (
    ExecutionError,
    check_not_root,
    default_shell,
    process_manager,
    resolve_project_root,
    validate_working_dir,
)
from app.port_manager import (
    ReservedPortError,
    allocate_port,
    inject_port_into_command,
    is_reserved,
    release_port,
    release_session,
)
from app.runtime_detect import detect_runtime, infer_commands, preview_url_from_output
from app.utils import now_ms


router = APIRouter(prefix="/preview", tags=["preview"])

# In-memory mapping: project_id -> session_id
# (Lost on restart, which is fine — orphaned sessions are marked stopped on startup.)
_preview_sessions: dict[str, str] = {}
# Track allocated port per session so we can release it on stop.
_session_ports: dict[str, int] = {}


class PreviewStatus(BaseModel):
    projectId: str
    state: str  # "idle" | "starting" | "running" | "error" | "stopped"
    url: Optional[str] = None
    sessionId: Optional[str] = None
    command: Optional[str] = None
    error: Optional[str] = None
    runtime: Optional[str] = None
    framework: Optional[str] = None


class StartPreviewRequest(BaseModel):
    commandOverride: Optional[str] = None
    workingSubdir: str = ""


class NoFreePortError(HTTPException):
    pass


@router.post("/start/{project_id}", response_model=PreviewStatus)
async def start_preview(project_id: str, body: StartPreviewRequest = StartPreviewRequest()):
    """Start a dev server for the project. Detects the runtime and picks the
    best 'run' command from the inferred commands. If a preview session is
    already running for this project, returns its current status."""
    check_not_root()

    # Check if there's already an active preview session for this project.
    existing_sid = _preview_sessions.get(project_id)
    if existing_sid:
        existing = process_manager.get(existing_sid)
        if existing and existing.status in ("running", "pending"):
            # Already running — return current status.
            return _build_status(project_id, existing_sid, existing)

    root = resolve_project_root(project_id)
    runtime = detect_runtime(root)
    commands = infer_commands(root, runtime)

    # Find the best run command (prefer "run" kind, then any long-running command).
    run_cmd = None
    if body.commandOverride:
        run_cmd = body.commandOverride
    else:
        for c in commands:
            if c.kind == "run" and c.command and c.available:
                run_cmd = c.command
                break
        if not run_cmd:
            # Fall back to any available long-running command.
            for c in commands:
                if c.long_running and c.command and c.available:
                    run_cmd = c.command
                    break

    if not run_cmd:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={
                "code": "no_run_command",
                "message": "No suitable dev server command found for this project. "
                           "Detected runtime: " + runtime.runtime + ". "
                           + (runtime.install_hint or "Add a 'dev' or 'start' script to package.json."),
            },
        )

    cwd = validate_working_dir(root, body.workingSubdir or "")

    # Generate a session id.
    session_id = f"pv-{uuid.uuid4().hex[:12]}"

    # Allocate a free, non-reserved port and inject it into the command.
    # Ports 5173 and 8000 are reserved for AI-Bolt itself and must never be
    # used by a preview server, regardless of the project's own config.
    try:
        allocated_port = allocate_port(session_id)
    except RuntimeError as exc:
        raise HTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "no_free_port", "message": str(exc)},
        )

    try:
        run_cmd = inject_port_into_command(run_cmd, allocated_port, runtime.framework)
    except ReservedPortError as exc:
        release_port(allocated_port)
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"code": "reserved_port", "message": str(exc)},
        )

    # Also set PORT env var as a fallback for frameworks that read it.
    env_extra = {"PORT": str(allocated_port)}

    session = await process_manager.start(
        session_id=session_id,
        project_id=project_id,
        command=run_cmd,
        working_dir=cwd,
        shell=default_shell(),
        kind="run",
        source="user",
        long_running=True,
        timeout_s=None,
        env_extra=env_extra,
    )

    _session_ports[session_id] = allocated_port

    _preview_sessions[project_id] = session_id

    # Store mapping in DB for persistence within the process lifetime.
    try:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO preview_sessions (project_id, session_id, command, runtime, framework, created_at)
                VALUES (?,?,?,?,?,?)
                ON CONFLICT(project_id) DO UPDATE SET
                  session_id = excluded.session_id,
                  command = excluded.command,
                  runtime = excluded.runtime,
                  framework = excluded.framework,
                  created_at = excluded.created_at
                """,
                (project_id, session_id, run_cmd, runtime.runtime, runtime.framework, now_ms()),
            )
    except Exception:
        pass

    return _build_status(project_id, session_id, session)


@router.post("/stop/{project_id}", response_model=PreviewStatus)
async def stop_preview(project_id: str):
    """Stop the active preview session for the project."""
    sid = _preview_sessions.get(project_id)
    if not sid:
        return PreviewStatus(projectId=project_id, state="idle")
    session = process_manager.get(sid)
    if not session:
        _preview_sessions.pop(project_id, None)
        release_session(sid)
        _session_ports.pop(sid, None)
        return PreviewStatus(projectId=project_id, state="idle")
    if session.status in ("running", "pending"):
        await process_manager.stop(sid)
    # Release the allocated port back to the pool.
    release_session(sid)
    _session_ports.pop(sid, None)
    return _build_status(project_id, sid, process_manager.get(sid))


@router.get("/status/{project_id}", response_model=PreviewStatus)
def get_preview_status(project_id: str):
    """Get the current preview status for a project."""
    sid = _preview_sessions.get(project_id)
    if not sid:
        return PreviewStatus(projectId=project_id, state="idle")
    session = process_manager.get(sid)
    if not session:
        _preview_sessions.pop(project_id, None)
        return PreviewStatus(projectId=project_id, state="idle")
    return _build_status(project_id, sid, session)


@router.get("/logs/{project_id}")
def get_preview_logs(project_id: str, tail: int = 200):
    """Get recent stdout/stderr from the preview session."""
    sid = _preview_sessions.get(project_id)
    if not sid:
        return {"projectId": project_id, "stdout": "", "stderr": "", "lines": []}
    session = process_manager.get(sid)
    if not session:
        return {"projectId": project_id, "stdout": "", "stderr": "", "lines": []}
    out = session.output.get_text()
    stdout_lines = out["stdout"].splitlines()[-tail:]
    stderr_lines = out["stderr"].splitlines()[-tail:]
    return {
        "projectId": project_id,
        "stdout": out["stdout"][-8000:],
        "stderr": out["stderr"][-8000:],
        "lines": [
            {"stream": "stdout", "text": line}
            for line in stdout_lines
        ] + [
            {"stream": "stderr", "text": line}
            for line in stderr_lines
        ],
    }


def _build_status(project_id: str, session_id: str, session) -> PreviewStatus:
    out = session.output.get_text()
    url = preview_url_from_output(out["stdout"] + "\n" + out["stderr"])

    # Validate extracted URL: if the server somehow bound to a reserved
    # port (e.g. ignored our --port flag), mark the session as error so the
    # user is not pointed at AI-Bolt's own frontend/backend.
    if url:
        for reserved in (5173, 8000):
            if f":{reserved}" in url:
                url = None
                break

    state = "starting"
    if session.status == "running":
        state = "running" if url else "starting"
    elif session.status == "pending":
        state = "starting"
    elif session.status == "completed":
        state = "stopped"
    elif session.status in ("failed", "timeout"):
        state = "error"
    elif session.status == "stopped":
        state = "stopped"

    error_msg = None
    if state == "error":
        stderr_tail = out["stderr"][-500:] if out["stderr"] else out["stdout"][-500:]
        error_msg = stderr_tail.strip() or f"Process exited with code {session.exit_code}"

    # Extract runtime/framework from the session's DB record if available.
    runtime_name = None
    framework_name = None
    try:
        with connect() as conn:
            row = conn.execute(
                "SELECT runtime, framework FROM preview_sessions WHERE project_id = ?",
                (project_id,),
            ).fetchone()
            if row:
                runtime_name = row["runtime"]
                framework_name = row["framework"]
    except Exception:
        pass

    return PreviewStatus(
        projectId=project_id,
        state=state,
        url=url,
        sessionId=session_id,
        command=session.command,
        error=error_msg,
        runtime=runtime_name,
        framework=framework_name,
    )


def clear_preview_session(project_id: str) -> None:
    """Called when a project is closed or switched to clean up the in-memory mapping."""
    sid = _preview_sessions.pop(project_id, None)
    if sid:
        release_session(sid)
        _session_ports.pop(sid, None)


def init_preview_table() -> None:
    """Create the preview_sessions table if it doesn't exist."""
    try:
        with connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS preview_sessions (
                    project_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    command TEXT,
                    runtime TEXT,
                    framework TEXT,
                    created_at INTEGER NOT NULL
                )
                """
            )
    except Exception:
        pass
