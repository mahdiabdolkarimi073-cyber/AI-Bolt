"""Tests for Phase 10 terminal routes — approval gates, project isolation,
runtime detection endpoint, and session lifecycle via the FastAPI TestClient.

Uses short finite commands (echo) so no long-running process is spawned.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.db import connect, run_migrations
from app.repositories import ProjectRepo
from app.terminal_routes import router as terminal_router


@pytest.fixture
def app(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> FastAPI:
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws))
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{tmp_path / 'test.db'}")
    from app import config as _config
    _config.settings = _config.Settings()
    with connect() as conn:
        run_migrations(conn)
    app = FastAPI()
    app.include_router(terminal_router)
    return app


@pytest.fixture
def client(app: FastAPI) -> TestClient:
    return TestClient(app)


@pytest.fixture
def registered_project(env: Path) -> dict:
    (env / "demo").mkdir()
    with connect() as conn:
        return ProjectRepo.create(conn, name="demo", path="demo", template="blank", workspace_path="demo")


class TestApprovalGates:
    def test_deps_command_requires_approval(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "npm install",
            "kind": "deps",
            "source": "user",
            "approved": False,
        })
        assert res.status_code == 403
        body = res.json()
        assert body["detail"]["code"] == "approval_required"

    def test_deps_command_with_approval_proceeds(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo installing",
            "kind": "deps",
            "source": "user",
            "approved": True,
        })
        assert res.status_code == 201
        assert res.json()["status"] in ("running", "completed", "failed")

    def test_ai_proposed_requires_approval(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo hello",
            "kind": "command",
            "source": "ai_proposed",
            "approved": False,
        })
        assert res.status_code == 403

    def test_ai_proposed_approved(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo hello",
            "kind": "command",
            "source": "ai_proposed",
            "approved": True,
        })
        assert res.status_code == 201

    def test_user_command_no_approval_needed(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo hi",
            "kind": "command",
            "source": "user",
            "approved": False,
        })
        assert res.status_code == 201


class TestProjectIsolation:
    def test_unknown_project_rejected(self, client: TestClient):
        res = client.post("/exec/sessions", json={
            "projectId": "prj-does-not-exist",
            "command": "echo hi",
            "kind": "command",
            "source": "user",
        })
        assert res.status_code == 400

    def test_traversal_working_dir_rejected(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo hi",
            "kind": "command",
            "source": "user",
            "workingSubdir": "../escape",
        })
        assert res.status_code == 400

    def test_nonexistent_working_dir_rejected(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo hi",
            "kind": "command",
            "source": "user",
            "workingSubdir": "no-such-dir",
        })
        assert res.status_code == 400


class TestRuntimeEndpoint:
    def test_detects_node_project(self, client: TestClient, registered_project: dict, env: Path):
        root = env / "demo"
        (root / "package.json").write_text(json.dumps({
            "name": "demo",
            "scripts": {"dev": "vite", "build": "vite build"},
            "devDependencies": {"vite": "^5"},
        }))
        res = client.get(f"/exec/runtime/{registered_project['id']}")
        assert res.status_code == 200
        body = res.json()
        assert body["runtime"]["runtime"] == "node"
        actions = [c["action"] for c in body["commands"]]
        assert "Run dev server" in actions

    def test_unknown_project_400(self, client: TestClient):
        res = client.get("/exec/runtime/prj-does-not-exist")
        assert res.status_code == 400


class TestSessionLifecycle:
    def test_list_sessions_empty(self, client: TestClient):
        res = client.get("/exec/sessions")
        assert res.status_code == 200
        assert res.json()["sessions"] == []

    def test_get_output_for_unknown_session(self, client: TestClient):
        res = client.get("/exec/sessions/ts-nonexistent/output")
        assert res.status_code == 404

    def test_stop_unknown_session(self, client: TestClient):
        res = client.post("/exec/sessions/ts-nonexistent/stop")
        assert res.status_code == 400

    def test_remove_unknown_session_idempotent(self, client: TestClient):
        res = client.delete("/exec/sessions/ts-nonexistent")
        assert res.status_code == 204


class TestDiagnosisApproval:
    def test_diagnose_unknown_session(self, client: TestClient, registered_project: dict):
        res = client.post("/exec/diagnose", json={
            "projectId": registered_project["id"],
            "sessionId": "ts-nope",
        })
        assert res.status_code == 404

    def test_diagnose_cross_project_forbidden(self, client: TestClient, registered_project: dict, env: Path):
        # Create a second project.
        (env / "other").mkdir()
        with connect() as conn:
            other = ProjectRepo.create(conn, name="other", path="other", template="blank", workspace_path="other")
        # Start a session in the first project.
        start = client.post("/exec/sessions", json={
            "projectId": registered_project["id"],
            "command": "echo hi",
            "kind": "command",
            "source": "user",
        })
        sid = start.json()["sessionId"]
        res = client.post("/exec/diagnose", json={
            "projectId": other["id"],
            "sessionId": sid,
            "allowSimulation": True,
        })
        assert res.status_code == 403
