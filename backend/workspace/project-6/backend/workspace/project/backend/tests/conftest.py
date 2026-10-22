"""Shared test fixtures for backend tests.

Each test gets a fresh temporary WORKSPACE_ROOT and an isolated SQLite
database, so no test ever touches a real user project directory.
"""
from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path
from typing import Iterator

import pytest


@pytest.fixture
def tmp_workspace(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A fresh WORKSPACE_ROOT under pytest's tmp_path."""
    ws = tmp_path / "workspace"
    ws.mkdir(parents=True, exist_ok=True)
    monkeypatch.setenv("WORKSPACE_ROOT", str(ws))
    # Force Settings to re-read env.
    from app import config as _config
    _config.settings = _config.Settings()
    return ws


@pytest.fixture
def tmp_db(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An isolated SQLite DB path under tmp_path."""
    db_file = tmp_path / "test.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_file}")
    from app import config as _config
    _config.settings = _config.Settings()
    # Re-run migrations against the new path.
    from app.db import connect, run_migrations
    with connect() as conn:
        run_migrations(conn)
    return db_file


@pytest.fixture
def env(tmp_workspace: Path, tmp_db: Path) -> Path:
    """Combined fixture: workspace + db ready. Returns workspace root."""
    return tmp_workspace


@pytest.fixture
def project_dir(env: Path) -> Path:
    """A registered project directory under the workspace root."""
    d = env / "proj-test"
    d.mkdir(parents=True, exist_ok=False)
    return d
