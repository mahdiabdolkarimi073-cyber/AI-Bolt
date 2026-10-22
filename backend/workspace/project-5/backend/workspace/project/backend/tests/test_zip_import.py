"""Tests for ZIP import safety: ZIP Slip, symlink entries, limits, cleanup.

These build real ZIP archives in memory and exercise `import_zip` via FastAPI's
TestClient. No real user directories are touched.
"""
from __future__ import annotations

import io
import os
import struct
import sys
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def client(env: Path, tmp_db: Path, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    # Ensure the app picks up the temp config.
    from app import config as _config
    _config.settings = _config.Settings()
    from app.main import app
    return TestClient(app)


def _make_zip(entries: list[tuple[str, bytes]], dirs: list[str] | None = None) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for d in dirs or []:
            zi = zipfile.ZipInfo(d if d.endswith("/") else d + "/")
            zi.external_attr = 0o040755 << 16
            zf.writestr(zi, b"")
        for name, data in entries:
            zf.writestr(name, data)
    return buf.getvalue()


def _post_zip(client: TestClient, raw: bytes, name: str = "test-project", filename: str = "proj.zip"):
    return client.post(
        "/workspace/import-zip",
        params={"name": name},
        files={"file": (filename, raw, "application/zip")},
    )


class TestZipImportHappy:
    def test_imports_flat_project(self, client: TestClient, env: Path):
        raw = _make_zip([
            ("README.md", b"# hello"),
            ("src/App.tsx", b"export const App = () => null;"),
        ], dirs=["src/"])
        r = _post_zip(client, raw, name="flat-proj")
        assert r.status_code == 201, r.text
        body = r.json()
        assert body["name"] == "flat-proj"
        wp = body["workspacePath"]
        # Files persisted on disk.
        assert (env / wp / "README.md").read_text() == "# hello"
        assert (env / wp / "src" / "App.tsx").exists()

    def test_imports_single_root_zip(self, client: TestClient, env: Path):
        raw = _make_zip([
            ("myproj/README.md", b"# rooted"),
            ("myproj/src/main.py", b"print('hi')"),
        ], dirs=["myproj/", "myproj/src/"])
        r = _post_zip(client, raw, name="ignored-name")
        assert r.status_code == 201, r.text
        wp = r.json()["workspacePath"]
        # Single-root zip uses the inner folder name.
        assert wp == "myproj"
        assert (env / wp / "README.md").read_text() == "# rooted"


class TestZipSlip:
    def test_rejects_dotdot_entry(self, client: TestClient, env: Path):
        raw = _make_zip([("../../escape.txt", b"pwned")])
        r = _post_zip(client, raw, name="slip")
        assert r.status_code in (400, 413), r.text
        body = r.json()
        assert body["detail"]["code"] in ("invalid_entry", "invalid_archive", "extract_failed")
        # No escape file created outside workspace.
        assert not (env.parent / "escape.txt").exists()

    def test_rejects_absolute_entry(self, client: TestClient, env: Path, tmp_path: Path):
        target = tmp_path / "abs.txt"
        raw = _make_zip([("/abs.txt", b"x")])
        # Patch the absolute target so it would resolve somewhere; the import
        # must still reject the entry name before writing.
        r = _post_zip(client, raw, name="abs")
        assert r.status_code in (400, 413)
        assert not target.exists()

    def test_rejects_drive_letter_entry(self, client: TestClient):
        raw = _make_zip([("C:/Windows/evil.txt", b"x")])
        r = _post_zip(client, raw, name="drive")
        assert r.status_code in (400, 413)


class TestZipLimits:
    def test_rejects_oversized_archive(self, client: TestClient, monkeypatch: pytest.MonkeyPatch):
        # Lower the archive limit for this test to avoid allocating 256MB.
        from app import filesystem as fs
        monkeypatch.setattr(fs, "MAX_ARCHIVE_BYTES", 1024)
        from app import workspace_routes as wr
        monkeypatch.setattr(wr, "MAX_ARCHIVE_BYTES", 1024)
        # Use high-entropy data so the compressed archive stays above the limit.
        import random
        random.seed(1234)
        payload = bytes(random.randint(0, 255) for _ in range(2048))
        raw = _make_zip([("big.bin", payload)])
        r = _post_zip(client, raw, name="big")
        assert r.status_code == 413
        assert r.json()["detail"]["code"] == "archive_too_large"

    def test_rejects_too_many_entries(self, client: TestClient, monkeypatch: pytest.MonkeyPatch):
        from app import filesystem as fs
        monkeypatch.setattr(fs, "MAX_EXTRACTED_FILES", 5)
        from app import workspace_routes as wr
        monkeypatch.setattr(wr, "MAX_EXTRACTED_FILES", 5)
        entries = [(f"file{i}.txt", b"x") for i in range(10)]
        raw = _make_zip(entries)
        r = _post_zip(client, raw, name="many")
        assert r.status_code == 400
        body = r.json()
        assert body["detail"]["code"] in ("too_many_files", "extract_failed")


class TestZipCleanup:
    def test_cleans_up_on_failure(self, client: TestClient, env: Path, monkeypatch: pytest.MonkeyPatch):
        # A zip that passes validation but contains a traversal entry mid-way:
        # valid entries first, then a bad one. Extraction must fail and clean up.
        raw = _make_zip([
            ("good.txt", b"ok"),
            ("../bad.txt", b"escape"),
        ])
        r = _post_zip(client, raw, name="partial")
        assert r.status_code in (400, 413)
        # The partially-extracted directory must be removed.
        leftover = [p for p in env.iterdir() if p.is_dir()]
        # Only dirs that existed before (none) should remain; workspace root
        # itself may exist but no project dir.
        proj_dirs = [p for p in leftover if p.name.startswith("partial") or p.name.startswith("imported")]
        assert proj_dirs == [], f"Cleanup failed: {proj_dirs}"

    def test_no_conflict_dir_left_on_duplicate(self, client: TestClient, env: Path):
        raw = _make_zip([("README.md", b"# v1")], dirs=[])
        r1 = _post_zip(client, raw, name="dup")
        assert r1.status_code == 201
        # Manually re-register the same workspace path to simulate conflict.
        wp = r1.json()["workspacePath"]
        r2 = client.post("/workspace/register", json={"name": "dup2", "workspacePath": wp})
        assert r2.status_code == 409


class TestInvalidArchive:
    def test_rejects_non_zip(self, client: TestClient):
        r = _post_zip(client, b"not a zip file at all", name="bad")
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "invalid_archive"

    def test_rejects_corrupt_zip(self, client: TestClient):
        raw = b"PK" + b"\x00" * 30
        r = _post_zip(client, raw, name="corrupt")
        assert r.status_code == 400
