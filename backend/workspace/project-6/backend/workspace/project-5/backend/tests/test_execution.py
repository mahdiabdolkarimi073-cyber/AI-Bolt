"""Tests for the Phase 10 execution engine.

Covers: working-directory validation, project isolation, shell resolution,
secret redaction, output bounding, session registry listing, and cleanup.
These tests do NOT spawn real long-running processes — they exercise the
pure helpers and the in-memory registry. Live subprocess streaming is tested
via the route tests with short finite commands.
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.execution import (
    MAX_COMMAND_CHARS,
    MAX_CONCURRENT_SESSIONS,
    ProcessManager,
    Session,
    SessionOutput,
    check_not_root,
    default_shell,
    redact_secrets,
    resolve_project_root,
    validate_working_dir,
)


# --- Working directory validation ---

class TestValidateWorkingDir:
    def test_project_root_when_no_subpath(self, project_dir: Path):
        assert validate_working_dir(project_dir, None) == project_dir
        assert validate_working_dir(project_dir, "") == project_dir
        assert validate_working_dir(project_dir, ".") == project_dir

    def test_accepts_existing_subdir(self, project_dir: Path):
        (project_dir / "src").mkdir()
        result = validate_working_dir(project_dir, "src")
        assert result == (project_dir / "src").resolve()

    def test_rejects_traversal(self, project_dir: Path):
        with pytest.raises(HTTPException) as exc:
            validate_working_dir(project_dir, "../escape")
        assert exc.value.status_code == 400

    def test_rejects_absolute(self, project_dir: Path):
        with pytest.raises(HTTPException) as exc:
            validate_working_dir(project_dir, "/etc")
        assert exc.value.status_code == 400

    def test_rejects_nonexistent(self, project_dir: Path):
        with pytest.raises(HTTPException) as exc:
            validate_working_dir(project_dir, "nope")
        assert exc.value.status_code == 400

    def test_rejects_escape_via_subdir(self, project_dir: Path, env: Path):
        (project_dir / "link").mkdir()
        with pytest.raises(HTTPException) as exc:
            validate_working_dir(project_dir, "link/../../escape")
        assert exc.value.status_code in (400, 403)


class TestResolveProjectRoot:
    def test_resolves_registered_project(self, env: Path, tmp_db):
        from app.db import connect
        from app.repositories import ProjectRepo
        (env / "myproj").mkdir()
        with connect() as conn:
            project = ProjectRepo.create(conn, name="myproj", path="myproj", template="blank", workspace_path="myproj")
        # The registered project resolves to its on-disk root.
        root = resolve_project_root(project["id"])
        assert root.name == "myproj"

    def test_missing_project_raises(self):
        with pytest.raises(HTTPException) as exc:
            resolve_project_root("prj-does-not-exist")
        assert exc.value.status_code == 400


# --- Secret redaction ---

class TestRedactSecrets:
    def test_redacts_openai_key(self):
        text = "using key sk-abcdefghijklmnopqrstuvwxyz123456 here"
        out = redact_secrets(text)
        assert "sk-REDACTED" in out
        assert "sk-abcdefghijklmnopqrstuvwxyz123456" not in out

    def test_redacts_google_key(self):
        text = "key=AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ123456789"
        out = redact_secrets(text)
        assert "AIza-REDACTED" in out

    def test_redacts_assignment(self):
        text = "API_KEY=secretvalue123"
        out = redact_secrets(text)
        assert "REDACTED" in out
        assert "secretvalue123" not in out

    def test_leaves_normal_text(self):
        text = "build succeeded in 412ms"
        assert redact_secrets(text) == text

    def test_redacts_jwt(self):
        text = "token=eyJabcdefghijklmnopqrstuvwxyz0123456789.abcdef"
        out = redact_secrets(text)
        assert "REDACTED" in out


# --- Shell resolution ---

class TestShellResolution:
    def test_returns_a_string(self):
        shell = default_shell()
        assert isinstance(shell, str) and len(shell) > 0

    def test_posix_shell_exists(self):
        import sys
        if sys.platform == "win32":
            return
        shell = default_shell()
        assert Path(shell).exists() or shell in ("bash", "sh")


# --- Root guard ---

class TestCheckNotRoot:
    def test_passes_as_non_root(self, monkeypatch):
        # Force geteuid to return a non-zero value.
        import os
        if not hasattr(os, "geteuid"):
            return  # Windows
        monkeypatch.setattr(os, "geteuid", lambda: 1000)
        check_not_root()  # should not raise

    def test_refuses_root(self, monkeypatch):
        import os
        if not hasattr(os, "geteuid"):
            return
        monkeypatch.setattr(os, "geteuid", lambda: 0)
        with pytest.raises(HTTPException) as exc:
            check_not_root()
        assert exc.value.status_code == 403


# --- SessionOutput bounding ---

class TestSessionOutput:
    def test_bounded_stdout(self):
        out = SessionOutput()
        out.append_stdout(b"x" * 100)
        assert len(out.stdout) == 100
        assert out.truncated is False

    def test_truncation_flag(self):
        out = SessionOutput()
        from app.execution import MAX_OUTPUT_BYTES
        out.append_stdout(b"x" * (MAX_OUTPUT_BYTES + 10))
        assert out.truncated is True
        assert len(out.stdout) == MAX_OUTPUT_BYTES

    def test_tail_capped(self):
        out = SessionOutput()
        out.update_tail("a" * 30_000)
        assert len(out.tail) <= 24_001  # MAX_TAIL_SNIPPET_CHARS

    def test_get_text_redacts(self):
        out = SessionOutput()
        out.append_stdout(b"sk-abcdefghijklmnopqrstuvwxyz123456 leaked")
        text = out.get_text()
        assert "sk-REDACTED" in text["stdout"]


# --- ProcessManager registry (no real spawn) ---

class TestProcessManagerRegistry:
    def test_list_for_project_filters(self):
        pm = ProcessManager()
        pm.sessions["s1"] = Session(id="s1", project_id="p1", command="ls", working_dir="/", shell="sh", kind="command", source="user", long_running=False, started_at=1)
        pm.sessions["s2"] = Session(id="s2", project_id="p2", command="ls", working_dir="/", shell="sh", kind="command", source="user", long_running=False, started_at=2)
        assert len(pm.list_for_project("p1")) == 1
        assert len(pm.list_for_project(None)) == 2

    def test_get_returns_session(self):
        pm = ProcessManager()
        pm.sessions["s1"] = Session(id="s1", project_id="p1", command="ls", working_dir="/", shell="sh", kind="command", source="user", long_running=False, started_at=1)
        assert pm.get("s1") is not None
        assert pm.get("nope") is None

    def test_active_count(self):
        pm = ProcessManager()
        s1 = Session(id="s1", project_id="p1", command="ls", working_dir="/", shell="sh", kind="command", source="user", long_running=False, started_at=1, status="running")
        pm.sessions["s1"] = s1
        assert pm.active_count() == 1


# --- Live subprocess (short finite command) ---

class TestLiveExecution:
    @pytest.mark.asyncio
    async def test_echo_command_completes(self, project_dir: Path, tmp_db):
        import sys
        if sys.platform == "win32":
            cmd = "echo hello"
        else:
            cmd = "echo hello"
        pm = ProcessManager()
        session = await pm.start(
            session_id="test-1",
            project_id="test",
            command=cmd,
            working_dir=project_dir,
            shell=default_shell(),
            kind="command",
            source="user",
            long_running=False,
            timeout_s=10.0,
        )
        # Wait for completion.
        for _ in range(50):
            if session.status not in ("running", "pending"):
                break
            await asyncio.sleep(0.1)
        assert session.status in ("completed", "failed")
        out = session.output.get_text()
        assert "hello" in out["stdout"]

    @pytest.mark.asyncio
    async def test_nonexistent_command_fails(self, project_dir: Path, tmp_db):
        pm = ProcessManager()
        session = await pm.start(
            session_id="test-2",
            project_id="test",
            command="this-command-does-not-exist-xyz",
            working_dir=project_dir,
            shell=default_shell(),
            kind="command",
            source="user",
            long_running=False,
            timeout_s=10.0,
        )
        for _ in range(50):
            if session.status not in ("running", "pending"):
                break
            await asyncio.sleep(0.1)
        assert session.status in ("failed", "completed")
        assert session.exit_code != 0

    @pytest.mark.asyncio
    async def test_stop_terminates(self, project_dir: Path, tmp_db):
        import sys
        if sys.platform == "win32":
            return  # sleep behavior on Windows differs; skip
        pm = ProcessManager()
        session = await pm.start(
            session_id="test-3",
            project_id="test",
            command="sleep 30",
            working_dir=project_dir,
            shell=default_shell(),
            kind="command",
            source="user",
            long_running=False,
            timeout_s=60.0,
        )
        await asyncio.sleep(0.3)
        assert session.status == "running"
        await pm.stop("test-3")
        assert session.status == "stopped"
