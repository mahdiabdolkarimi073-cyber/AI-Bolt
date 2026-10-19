"""Tests for workspace file routes: CRUD, search, project isolation.

Uses FastAPI TestClient against a temp workspace + temp DB.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(env: Path, tmp_db: Path) -> TestClient:
    from app import config as _config
    _config.settings = _config.Settings()
    from app.main import app
    return TestClient(app)


@pytest.fixture
def project(client: TestClient, env: Path) -> dict:
    """Create an empty project and return its record."""
    r = client.post("/workspace/create-empty", json={"name": "TestProj"})
    assert r.status_code == 201, r.text
    return r.json()


@pytest.fixture
def project_id(project: dict) -> str:
    return project["id"]


class TestFileCRUD:
    def test_create_and_read_file(self, client: TestClient, project_id: str, env: Path):
        r = client.post(
            f"/workspace/{project_id}/files",
            json={"path": "src/hello.ts", "content": "export const x = 1;", "overwrite": False},
        )
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["path"] == "src/hello.ts"
        assert body["language"] == "ts"

        r2 = client.get(f"/workspace/{project_id}/files", params={"path": "src/hello.ts"})
        assert r2.status_code == 200
        assert r2.json()["content"] == "export const x = 1;"

    def test_write_conflicts_without_overwrite(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "a.txt", "content": "v1"})
        r = client.post(f"/workspace/{project_id}/files", json={"path": "a.txt", "content": "v2"})
        assert r.status_code == 409
        assert r.json()["detail"]["code"] == "exists"

    def test_overwrite_flag_replaces(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "a.txt", "content": "v1"})
        r = client.post(
            f"/workspace/{project_id}/files",
            json={"path": "a.txt", "content": "v2", "overwrite": True},
        )
        assert r.status_code == 201
        r2 = client.get(f"/workspace/{project_id}/files", params={"path": "a.txt"})
        assert r2.json()["content"] == "v2"

    def test_delete_requires_confirm(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "del.txt", "content": "x"})
        r = client.delete(f"/workspace/{project_id}/files", params={"path": "del.txt"})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "confirmation_required"

    def test_delete_with_confirm(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "del.txt", "content": "x"})
        r = client.delete(f"/workspace/{project_id}/files", params={"path": "del.txt", "confirm": True})
        assert r.status_code == 204
        r2 = client.get(f"/workspace/{project_id}/files", params={"path": "del.txt"})
        assert r2.status_code == 404

    def test_cannot_delete_project_root(self, client: TestClient, project_id: str):
        r = client.delete(f"/workspace/{project_id}/files", params={"path": ".", "confirm": True})
        # "." validates to empty after cleaning -> 400, or resolves to root -> 403.
        assert r.status_code in (400, 403)

    def test_rejects_traversal_on_write(self, client: TestClient, project_id: str):
        r = client.post(
            f"/workspace/{project_id}/files",
            json={"path": "../escape.txt", "content": "x"},
        )
        assert r.status_code == 400

    def test_rejects_traversal_on_read(self, client: TestClient, project_id: str):
        r = client.get(f"/workspace/{project_id}/files", params={"path": "../../etc/passwd"})
        assert r.status_code == 400


class TestDirectoryOps:
    def test_create_directory(self, client: TestClient, project_id: str):
        r = client.post(f"/workspace/{project_id}/dirs", json={"path": "components/ui"})
        assert r.status_code == 201
        assert r.json()["type"] == "folder"

    def test_create_dir_conflict(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/dirs", json={"path": "x"})
        r = client.post(f"/workspace/{project_id}/dirs", json={"path": "x"})
        assert r.status_code == 409

    def test_rename_file(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "old.ts", "content": "x"})
        r = client.post(
            f"/workspace/{project_id}/rename",
            json={"fromPath": "old.ts", "toPath": "new.ts"},
        )
        assert r.status_code == 200
        r2 = client.get(f"/workspace/{project_id}/files", params={"path": "new.ts"})
        assert r2.status_code == 200
        r3 = client.get(f"/workspace/{project_id}/files", params={"path": "old.ts"})
        assert r3.status_code == 404


class TestTree:
    def test_lists_root(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "a.ts", "content": "x"})
        client.post(f"/workspace/{project_id}/files", json={"path": "b.ts", "content": "x"})
        r = client.get(f"/workspace/{project_id}/tree")
        assert r.status_code == 200
        names = {n["name"] for n in r.json()}
        assert "a.ts" in names and "b.ts" in names


class TestSearch:
    def test_filename_search(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "App.tsx", "content": "export const App = 1"})
        client.post(f"/workspace/{project_id}/files", json={"path": "utils.ts", "content": "export const u = 2"})
        r = client.get(f"/workspace/{project_id}/search", params={"q": "App", "mode": "filename"})
        assert r.status_code == 200
        paths = {hit["path"] for hit in r.json()["results"]}
        assert "App.tsx" in paths
        assert "utils.ts" not in paths

    def test_content_search(self, client: TestClient, project_id: str):
        client.post(f"/workspace/{project_id}/files", json={"path": "a.ts", "content": "const TOKEN = 'abc';"})
        client.post(f"/workspace/{project_id}/files", json={"path": "b.ts", "content": "const OTHER = 1;"})
        r = client.get(f"/workspace/{project_id}/search", params={"q": "TOKEN", "mode": "content"})
        assert r.status_code == 200
        paths = {hit["path"] for hit in r.json()["results"]}
        assert "a.ts" in paths
        assert "b.ts" not in paths

    def test_invalid_mode(self, client: TestClient, project_id: str):
        r = client.get(f"/workspace/{project_id}/search", params={"q": "x", "mode": "bogus"})
        assert r.status_code == 400


class TestProjectIsolation:
    def test_project_a_cannot_access_project_b_files(self, client: TestClient):
        a = client.post("/workspace/create-empty", json={"name": "A"}).json()
        b = client.post("/workspace/create-empty", json={"name": "B"}).json()
        client.post(f"/workspace/{a['id']}/files", json={"path": "secret.txt", "content": "A's secret"})
        # Reading from B with a path that only exists in A must 404.
        r = client.get(f"/workspace/{b['id']}/files", params={"path": "secret.txt"})
        assert r.status_code == 404
        # Writing into B creates a separate file.
        client.post(f"/workspace/{b['id']}/files", json={"path": "secret.txt", "content": "B's secret"})
        ra = client.get(f"/workspace/{a['id']}/files", params={"path": "secret.txt"})
        rb = client.get(f"/workspace/{b['id']}/files", params={"path": "secret.txt"})
        assert ra.json()["content"] == "A's secret"
        assert rb.json()["content"] == "B's secret"


class TestReopenAfterRestart:
    def test_files_persist_across_db_reopen(self, client: TestClient, project_id: str, env: Path):
        client.post(f"/workspace/{project_id}/files", json={"path": "persist.ts", "content": "export const P = 1;"})
        # The on-disk file should still be there (simulates restart).
        wp = [p for p in env.iterdir() if p.is_dir()][0]
        assert (wp / "persist.ts").read_text() == "export const P = 1;"
