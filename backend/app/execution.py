"""Phase 10 — execution engine: real process lifecycle for the local IDE.

Responsibilities:
  * Spawn host processes with a validated working directory.
  * Stream stdout/stderr incrementally via async queues.
  * Cancel (terminate) processes including child cleanup.
  * Enforce concurrency, runtime, output-size, and per-session limits.
  * Distinguish finite commands from long-running dev servers.
  * Redact obvious secrets from output before they reach the UI or AI context.
  * Register metadata in the `terminal_sessions` table (not full output).

Trust boundary (documented honestly):
  The backend listens on 127.0.0.1 for a single developer's machine. This is
  NOT an OS-level sandbox. We rely on:
    - The local-only bind address (no remote exposure).
    - Working-directory validation against a registered project root.
    - Explicit approval gates for AI-proposed and sensitive commands (enforced
      in the routes layer, not here).
    - Refusal to run as root/admin (checked at startup of a session).
    - Bounded output, runtime, and concurrency limits.

We do NOT claim full process isolation. We do not run uploaded project scripts
or package lifecycle scripts automatically — every such action requires an
explicit approved request from the user.
"""
from __future__ import annotations

import asyncio
import os
import re
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, status

from app.config import workspace_root_path
from app.db import connect
from app.filesystem import project_root_on_disk
from app.repositories import ProjectRepo


# --- Limits (tuned for an 8 GB personal machine) ---

MAX_CONCURRENT_SESSIONS = 8
MAX_OUTPUT_BYTES = 2 * 1024 * 1024          # 2 MB captured per stream (stdout + stderr)
MAX_TAIL_SNIPPET_CHARS = 24_000             # stored snippet for UI restore
DEFAULT_TIMEOUT_S = 120.0                   # finite commands
LONG_RUN_TIMEOUT_S = 60 * 60 * 6.0          # long-running dev servers (6h cap)
MAX_COMMAND_CHARS = 4000

# Substrings commonly found in secrets. We redact lines that look like these.
_SECRET_PATTERNS = (
    re.compile(r"(?i)(sk-[A-Za-z0-9_-]{12,})"),
    re.compile(r"(?i)(AIza[A-Za-z0-9_-]{20,})"),
    re.compile(r"(?i)(xox[baprs]-[A-Za-z0-9-]+)"),
    re.compile(r"(?i)(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+)"),  # JWT-ish
    re.compile(r"(?i)((?:api[_-]?key|secret|token|password|passwd|pwd)\s*[=:]\s*)([^\s'\"]+)"),
)


def redact_secrets(text: str) -> str:
    """Best-effort redaction of common secret shapes from a chunk of text."""
    redacted = text
    redacted = _SECRET_PATTERNS[0].sub("sk-REDACTED", redacted)
    redacted = _SECRET_PATTERNS[1].sub("AIza-REDACTED", redacted)
    redacted = _SECRET_PATTERNS[2].sub("xox-REDACTED", redacted)
    redacted = _SECRET_PATTERNS[3].sub("eyJ-REDACTED.REDACTED", redacted)
    redacted = _SECRET_PATTERNS[4].sub(lambda m: f"{m.group(1)}REDACTED", redacted)
    return redacted


# --- Working directory validation ---


class ExecutionError(HTTPException):
    """Typed execution error mapped to an HTTP response."""


def _bad(msg: str, code: str = "invalid_request") -> ExecutionError:
    return ExecutionError(status.HTTP_400_BAD_REQUEST, detail={"code": code, "message": msg})


def _forbidden(msg: str, code: str = "forbidden") -> ExecutionError:
    return ExecutionError(status.HTTP_403_FORBIDDEN, detail={"code": code, "message": msg})


def resolve_project_root(project_id: str) -> Path:
    """Resolve the on-disk root for a registered project id."""
    with connect() as conn:
        project = ProjectRepo.get(conn, project_id)
    if not project:
        raise _bad("Project not found.", "not_found")
    wp = project.get("workspacePath")
    if not wp:
        raise _bad("Project has no on-disk workspace.", "project_not_imported")
    root = project_root_on_disk(wp)
    if not root.exists() or not root.is_dir():
        raise _bad("Project directory is missing on disk.", "project_not_imported")
    return root


def validate_working_dir(project_root: Path, subpath: Optional[str]) -> Path:
    """Validate a requested working directory. `subpath` is relative to the
    project root (or None/'' for the root itself). The directory must exist and
    be contained within the project root."""
    if not subpath or subpath.strip() in ("", ".", "./"):
        return project_root
    norm = subpath.replace("\\", "/")
    if norm.startswith("/"):
        raise _bad("Absolute working directory is not allowed.", "invalid_path")
    for part in norm.split("/"):
        if part == "..":
            raise _bad("Path traversal (..) is not allowed.", "invalid_path")
        if any(ord(c) < 32 for c in part):
            raise _bad("Invalid characters in working directory.", "invalid_path")
    candidate = (project_root / norm).resolve(strict=False)
    try:
        if os.path.commonpath([str(candidate), str(project_root)]) != str(project_root):
            raise _forbidden("Working directory escapes the project root.")
    except ValueError:
        raise _forbidden("Working directory escapes the project root.")
    if not candidate.exists() or not candidate.is_dir():
        raise _bad("Working directory does not exist.", "not_found")
    return candidate


# --- Shell resolution ---


def default_shell() -> str:
    """Pick a sensible shell for the host platform. On Windows, prefer
    PowerShell if available, else cmd. On POSIX, use $SHELL or bash/sh."""
    if sys.platform == "win32":
        # Prefer PowerShell Core (pwsh) then Windows PowerShell.
        for candidate in ("pwsh", "powershell"):
            found = _which(candidate)
            if found:
                return found
        return "cmd.exe"
    shell = os.environ.get("SHELL", "")
    if shell and Path(shell).exists():
        return shell
    for candidate in ("/bin/bash", "/bin/sh"):
        if Path(candidate).exists():
            return candidate
    return "/bin/sh"


def _which(name: str) -> Optional[str]:
    """Cross-platform `which`/`where` without spawning a process."""
    paths = os.environ.get("PATH", "").split(os.pathsep)
    exts = os.environ.get("PATHEXT", "").split(os.pathsep) if sys.platform == "win32" else [""]
    for base in paths:
        if not base:
            continue
        for ext in exts:
            candidate = Path(base) / (name + ext)
            if candidate.exists() and os.access(candidate, os.X_OK):
                return str(candidate)
    return None


def detect_tool(name: str) -> Optional[str]:
    """Return absolute path to an installed tool, or None if missing."""
    return _which(name)


# --- Session record ---


@dataclass
class SessionOutput:
    """In-memory output buffer for a session. Bounded by MAX_OUTPUT_BYTES."""
    stdout: bytearray = field(default_factory=bytearray)
    stderr: bytearray = field(default_factory=bytearray)
    tail: str = ""
    truncated: bool = False

    def append_stdout(self, data: bytes) -> None:
        if len(self.stdout) < MAX_OUTPUT_BYTES:
            self.stdout.extend(data)
        else:
            self.truncated = True

    def append_stderr(self, data: bytes) -> None:
        if len(self.stderr) < MAX_OUTPUT_BYTES:
            self.stderr.extend(data)
        else:
            self.truncated = True

    def get_text(self) -> dict:
        out = self.stdout.decode("utf-8", errors="replace")
        err = self.stderr.decode("utf-8", errors="replace")
        return {"stdout": redact_secrets(out), "stderr": redact_secrets(err), "truncated": self.truncated}

    def update_tail(self, chunk: str) -> None:
        combined = self.tail + chunk
        if len(combined) > MAX_TAIL_SNIPPET_CHARS:
            combined = combined[-MAX_TAIL_SNIPPET_CHARS:]
        self.tail = combined


@dataclass
class Session:
    id: str
    project_id: str
    command: str
    working_dir: str
    shell: str
    kind: str
    source: str
    long_running: bool
    status: str = "pending"
    exit_code: Optional[int] = None
    started_at: int = 0
    finished_at: Optional[int] = None
    proc: Optional[asyncio.subprocess.Process] = None
    output: SessionOutput = field(default_factory=SessionOutput)
    queue: "asyncio.Queue[dict]" = field(default_factory=asyncio.Queue)
    cancelled: bool = False
    timeout_task: Optional[asyncio.Task] = None
    reader_tasks: list[asyncio.Task] = field(default_factory=list)


# --- Process manager (singleton per process) ---


class ProcessManager:
    """In-process registry of active sessions. Owns the asyncio subprocesses.

    This is a single-process FastAPI server, so a module-level singleton is
    appropriate. State is lost on backend restart; the DB rows remain for
    history and are marked `stopped` on startup if found `running`.
    """

    def __init__(self) -> None:
        self.sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    def active_count(self) -> int:
        return sum(1 for s in self.sessions.values() if s.status == "running")

    def get(self, session_id: str) -> Optional[Session]:
        return self.sessions.get(session_id)

    def list_for_project(self, project_id: Optional[str]) -> list[dict]:
        out: list[dict] = []
        for s in self.sessions.values():
            if project_id is not None and s.project_id != project_id:
                continue
            out.append(_session_summary(s))
        out.sort(key=lambda r: r.get("startedAt", 0), reverse=True)
        return out

    async def start(
        self,
        *,
        session_id: str,
        project_id: str,
        command: str,
        working_dir: Path,
        shell: Optional[str],
        kind: str,
        source: str,
        long_running: bool,
        timeout_s: Optional[float],
        env_extra: Optional[dict[str, str]] = None,
    ) -> Session:
        if len(command) > MAX_COMMAND_CHARS:
            raise _bad("Command is too long.", "invalid_request")
        async with self._lock:
            if self.active_count() >= MAX_CONCURRENT_SESSIONS:
                raise _forbidden("Too many concurrent sessions. Stop one first.", "concurrency_limit")
            session = Session(
                id=session_id,
                project_id=project_id,
                command=command,
                working_dir=str(working_dir),
                shell=shell or default_shell(),
                kind=kind,
                source=source,
                long_running=long_running,
                started_at=int(time.time() * 1000),
            )
            self.sessions[session_id] = session

        # Build argv. We intentionally do NOT invoke arbitrary shell features
        # beyond what the chosen shell provides. For cmd.exe we use /C; for
        # PowerShell -NoProfile -Command; for POSIX shells -c.
        argv = _build_shell_argv(session.shell, command)
        env = os.environ.copy()
        if env_extra:
            env.update({k: v for k, v in env_extra.items() if v is not None})
        # Force non-interactive, predictable locale.
        env.setdefault("TERM", "dumb")
        env.setdefault("NO_COLOR", "1")
        env.setdefault("CI", "1")

        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                cwd=str(working_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
                env=env,
                start_new_session=True,
            )
        except FileNotFoundError:
            session.status = "failed"
            session.exit_code = 127
            session.finished_at = int(time.time() * 1000)
            await session.queue.put({"type": "error", "code": "shell_not_found", "message": f"Shell not found: {session.shell}"})
            await session.queue.put({"type": "end", "exitCode": 127})
            await _persist_session_end(session)
            return session
        except PermissionError:
            session.status = "failed"
            session.exit_code = 126
            session.finished_at = int(time.time() * 1000)
            await session.queue.put({"type": "error", "code": "permission_denied", "message": "Permission denied when starting process."})
            await session.queue.put({"type": "end", "exitCode": 126})
            await _persist_session_end(session)
            return session
        except OSError as exc:
            session.status = "failed"
            session.finished_at = int(time.time() * 1000)
            await session.queue.put({"type": "error", "code": "spawn_failed", "message": f"Failed to start process: {exc}"})
            await session.queue.put({"type": "end", "exitCode": -1})
            await _persist_session_end(session)
            return session

        session.proc = proc
        session.status = "running"
        _persist_session_start(
            session_id=session.id,
            project_id=session.project_id,
            command=session.command,
            working_dir=session.working_dir,
            shell=session.shell,
            kind=session.kind,
            source=session.source,
            long_running=session.long_running,
        )

        # Timeout.
        effective_timeout = timeout_s if timeout_s is not None else (
            LONG_RUN_TIMEOUT_S if long_running else DEFAULT_TIMEOUT_S
        )

        async def _timeout() -> None:
            try:
                await asyncio.sleep(effective_timeout)
                if session.status == "running":
                    session.status = "timeout"
                    await self._terminate(session)
                    await session.queue.put({"type": "timeout", "timeoutS": effective_timeout})
            except asyncio.CancelledError:
                pass

        if effective_timeout > 0:
            session.timeout_task = asyncio.create_task(_timeout())

        # Output readers.
        async def _read(stream, kind: str) -> None:
            assert proc is not None
            try:
                while True:
                    chunk = await stream.read(4096)
                    if not chunk:
                        break
                    text = chunk.decode("utf-8", errors="replace")
                    redacted = redact_secrets(text)
                    if kind == "stdout":
                        session.output.append_stdout(chunk)
                    else:
                        session.output.append_stderr(chunk)
                    session.output.update_tail(redacted)
                    await session.queue.put({"type": "stream", "stream": kind, "text": redacted})
            except asyncio.CancelledError:
                pass

        session.reader_tasks = [
            asyncio.create_task(_read(proc.stdout, "stdout")),
            asyncio.create_task(_read(proc.stderr, "stderr")),
        ]

        asyncio.create_task(self._await_completion(session))
        return session

    async def _await_completion(self, session: Session) -> None:
        proc = session.proc
        if proc is None:
            return
        try:
            code = await proc.wait()
        except asyncio.CancelledError:
            return
        for t in session.reader_tasks:
            try:
                await t
            except asyncio.CancelledError:
                pass
        if session.timeout_task and not session.timeout_task.done():
            session.timeout_task.cancel()
        session.finished_at = int(time.time() * 1000)
        session.exit_code = code
        if session.status == "running":
            session.status = "completed" if code == 0 else "failed"
        if session.status == "timeout":
            # keep timeout status but record the code
            pass
        await session.queue.put({"type": "end", "exitCode": code, "status": session.status})
        await _persist_session_end(session)

    async def _terminate(self, session: Session) -> None:
        proc = session.proc
        if proc is None or proc.returncode is not None:
            return
        try:
            if sys.platform == "win32":
                proc.terminate()
            else:
                # Send SIGTERM to the whole process group (start_new_session=True).
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                except (ProcessLookupError, PermissionError):
                    proc.terminate()
        except ProcessLookupError:
            return
        except PermissionError:
            return
        # Give it a moment, then escalate.
        try:
            await asyncio.wait_for(proc.wait(), timeout=3.0)
        except asyncio.TimeoutError:
            try:
                if sys.platform != "win32":
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError):
                        proc.kill()
                else:
                    proc.kill()
            except ProcessLookupError:
                pass

    async def stop(self, session_id: str) -> dict:
        session = self.sessions.get(session_id)
        if not session:
            raise _bad("Session not found.", "not_found")
        if session.status not in ("running", "pending"):
            return _session_summary(session)
        session.status = "stopped"
        session.cancelled = True
        await self._terminate(session)
        session.finished_at = int(time.time() * 1000)
        await session.queue.put({"type": "stopped"})
        await _persist_session_end(session)
        return _session_summary(session)

    async def clear_output(self, session_id: str) -> dict:
        session = self.sessions.get(session_id)
        if not session:
            raise _bad("Session not found.", "not_found")
        session.output = SessionOutput()
        return {"sessionId": session_id, "cleared": True}

    async def remove(self, session_id: str) -> dict:
        session = self.sessions.get(session_id)
        if not session:
            return {"sessionId": session_id, "removed": True}
        if session.status in ("running", "pending"):
            await self.stop(session_id)
        self.sessions.pop(session_id, None)
        from app.db import connect as _connect
        from app.utils import now_ms
        try:
            with _connect() as conn:
                conn.execute("DELETE FROM terminal_output_snippets WHERE session_id = ?", (session_id,))
                conn.execute("DELETE FROM terminal_sessions WHERE id = ?", (session_id,))
        except Exception:
            pass
        return {"sessionId": session_id, "removed": True}

    def cleanup_all(self) -> None:
        """Best-effort termination of all running sessions (called on shutdown)."""
        for session in list(self.sessions.values()):
            if session.status in ("running", "pending"):
                session.status = "stopped"
                proc = session.proc
                if proc and proc.returncode is None:
                    try:
                        if sys.platform == "win32":
                            proc.terminate()
                        else:
                            try:
                                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                            except (ProcessLookupError, PermissionError):
                                proc.kill()
                    except ProcessLookupError:
                        pass


# Module-level singleton.
process_manager = ProcessManager()


def _build_shell_argv(shell: str, command: str) -> list[str]:
    """Build argv for the chosen shell. Windows PowerShell and cmd.exe differ
    from POSIX shells."""
    name = Path(shell).name.lower()
    if "powershell" in name or name == "pwsh":
        return [shell, "-NoProfile", "-NonInteractive", "-Command", command]
    if name == "cmd.exe":
        return [shell, "/C", command]
    # POSIX shells.
    return [shell, "-c", command]


def _session_summary(s: Session) -> dict:
    return {
        "id": s.id,
        "projectId": s.project_id,
        "command": s.command,
        "workingDir": s.working_dir,
        "shell": s.shell,
        "kind": s.kind,
        "source": s.source,
        "longRunning": s.long_running,
        "status": s.status,
        "exitCode": s.exit_code,
        "startedAt": s.started_at,
        "finishedAt": s.finished_at,
        "truncated": s.output.truncated,
    }


# --- Persistence helpers ---


def _persist_session_start(
    *,
    session_id: str,
    project_id: str,
    command: str,
    working_dir: str,
    shell: str,
    kind: str,
    source: str,
    long_running: bool,
) -> None:
    from app.utils import now_ms
    try:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO terminal_sessions
                  (id, project_id, command, working_dir, shell, kind, source,
                   long_running, status, started_at)
                VALUES (?,?,?,?,?,?,?,?,?,?)
                """,
                (session_id, project_id, command, working_dir, shell, kind, source,
                 int(long_running), "running", now_ms()),
            )
    except Exception:
        pass


async def _persist_session_end(session: Session) -> None:
    from app.utils import now_ms
    out = session.output.get_text()
    tail = (out["stdout"] + "\n" + out["stderr"])[-MAX_TAIL_SNIPPET_CHARS:]
    try:
        with connect() as conn:
            conn.execute(
                """
                UPDATE terminal_sessions
                SET status = ?, exit_code = ?, finished_at = ?,
                    output_chars = ?, truncated = ?
                WHERE id = ?
                """,
                (session.status, session.exit_code, session.finished_at or now_ms(),
                 len(out["stdout"]) + len(out["stderr"]), int(session.output.truncated),
                 session.id),
            )
            conn.execute(
                """
                INSERT INTO terminal_output_snippets (session_id, tail_text, tail_chars, updated_at)
                VALUES (?,?,?,?)
                ON CONFLICT(session_id) DO UPDATE SET
                  tail_text = excluded.tail_text,
                  tail_chars = excluded.tail_chars,
                  updated_at = excluded.updated_at
                """,
                (session.id, tail, len(tail), now_ms()),
            )
    except Exception:
        pass


def mark_stale_sessions_stopped() -> None:
    """On startup, mark any DB rows still 'running' as 'stopped' (orphaned)."""
    from app.utils import now_ms
    try:
        with connect() as conn:
            conn.execute(
                "UPDATE terminal_sessions SET status = 'stopped', finished_at = ? "
                "WHERE status IN ('running','pending')",
                (now_ms(),),
            )
    except Exception:
        pass


# Refuse to operate as root/admin (POSIX only; Windows check is advisory).
def check_not_root() -> None:
    if sys.platform != "win32":
        if hasattr(os, "geteuid") and os.geteuid() == 0:
            raise _forbidden(
                "Refusing to run commands as root. Start the backend as a normal user.",
                "running_as_root",
            )
