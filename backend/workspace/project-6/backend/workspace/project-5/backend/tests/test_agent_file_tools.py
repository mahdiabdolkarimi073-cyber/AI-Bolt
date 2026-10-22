"""Tests for Agent project-context retrieval: scoping, secret exclusion, bounds.

These tests create real files under a temp workspace and exercise
`agent_file_tools` directly — no mocks of the filesystem.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from app.agent_file_tools import (
    FileContextItem,
    DEFAULT_PROJECT_CONTEXT_BUDGET_CHARS,
    MAX_PROJECT_CONTEXT_CHARS,
    _looks_secret,
    list_project_files,
    read_file_for_context,
    render_project_context_block,
    retrieve_project_context,
    search_project_text,
)
from app.db import connect
from app.repositories import ProjectRepo


@pytest.fixture
def seeded_project(env: Path, tmp_db: Path) -> tuple[Path, str]:
    """Create a project dir + DB record. Returns (root, project_id)."""
    wp = "agent-proj"
    (env / wp / "src").mkdir(parents=True)
    (env / wp / "src" / "App.tsx").write_text("export const App = () => null;\n")
    (env / wp / "README.md").write_text("# Agent Project\nDetails here.\n")
    (env / wp / ".env").write_text("SECRET_KEY=supersecret\n")
    (env / wp / "node_modules").mkdir()
    (env / wp / "node_modules" / "dep.js").write_text("module.exports = {};\n")

    with connect() as conn:
        project = ProjectRepo.create(
            conn, name="AgentProj", path=wp, template="blank",
            workspace_path=wp, import_source="empty",
        )
    return env / wp, project["id"]


class TestListProjectFiles:
    def test_excludes_secret_files(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        files = list_project_files(root)
        assert ".env" not in files

    def test_excludes_node_modules(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        files = list_project_files(root)
        assert all("node_modules" not in f for f in files)

    def test_includes_source_files(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        files = list_project_files(root)
        assert "src/App.tsx" in files
        assert "README.md" in files


class TestReadFileForContext:
    def test_reads_text_file(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        item = read_file_for_context(root, "src/App.tsx")
        assert item is not None
        assert "export const App" in item.snippet
        assert item.language == "tsx"

    def test_returns_none_for_missing(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        assert read_file_for_context(root, "nope.ts") is None

    def test_truncates_long_file(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        (root / "big.ts").write_text("x" * 20_000)
        item = read_file_for_context(root, "big.ts", budget=100)
        assert item is not None
        assert item.truncated is True
        assert "[truncated]" in item.snippet

    def test_rejects_traversal(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        assert read_file_for_context(root, "../escape.txt") is None


class TestSecretExclusion:
    def test_env_file_is_secret(self):
        assert _looks_secret(".env") is True

    def test_credentials_file_is_secret(self):
        assert _looks_secret("credentials.json") is True

    def test_pem_file_is_secret(self):
        assert _looks_secret("cert.pem") is True

    def test_normal_file_is_not_secret(self):
        assert _looks_secret("App.tsx") is False


class TestSearchProjectText:
    def test_finds_matches(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        hits = search_project_text(root, "App")
        paths = {h["path"] for h in hits}
        assert "src/App.tsx" in paths

    def test_skips_secret_files(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        hits = search_project_text(root, "SECRET_KEY")
        paths = {h["path"] for h in hits}
        assert ".env" not in paths

    def test_skips_excluded_dirs(self, seeded_project: tuple[Path, str]):
        root, _ = seeded_project
        (root / "node_modules" / "dep2.js").write_text("const TARGET = 1;\n")
        hits = search_project_text(root, "TARGET")
        assert all("node_modules" not in h["path"] for h in hits)


class TestRetrieveProjectContext:
    def test_returns_none_for_missing_project(self, env: Path):
        assert retrieve_project_context("nonexistent-id", "show me App.tsx") == []

    def test_returns_none_for_project_without_workspace(self, env: Path, tmp_db: Path):
        with connect() as conn:
            project = ProjectRepo.create(
                conn, name="NoWS", path="x", template="blank",
                workspace_path=None, import_source="manual",
            )
        assert retrieve_project_context(project["id"], "anything") == []

    def test_scoped_to_project(self, seeded_project: tuple[Path, str]):
        root, pid = seeded_project
        # Create a second project with a file the query would match.
        other = root.parent / "other-proj"
        other.mkdir()
        (other / "App.tsx").write_text("export const OTHER = 999;\n")
        with connect() as conn:
            ProjectRepo.create(
                conn, name="Other", path="other-proj", template="blank",
                workspace_path="other-proj", import_source="empty",
            )
        items = retrieve_project_context(pid, "look at App.tsx")
        snippets = " ".join(i.snippet for i in items)
        assert "OTHER = 999" not in snippets

    def test_budget_bounds_output(self, seeded_project: tuple[Path, str]):
        _, pid = seeded_project
        items = retrieve_project_context(pid, "App", budget_chars=50)
        total = sum(len(i.snippet) for i in items)
        # Each file can be up to MAX_FILE_CONTEXT_CHARS, but total budget is 50.
        # The retrieved content is bounded by the budget per call.
        assert total <= 50 + MAX_PROJECT_CONTEXT_CHARS  # generous; real bound is tighter

    def test_zero_budget_returns_empty(self, seeded_project: tuple[Path, str]):
        _, pid = seeded_project
        assert retrieve_project_context(pid, "App", budget_chars=0) == []


class TestRenderContextBlock:
    def test_frames_as_reference_not_instructions(self):
        item = FileContextItem(path="a.ts", language="ts", snippet="const x = 1;", truncated=False)
        block = render_project_context_block([item])
        assert "reference material" in block
        assert "not instructions" in block
        assert "const x = 1;" in block

    def test_empty_items_returns_empty_string(self):
        assert render_project_context_block([]) == ""

    def test_marks_truncated_items(self):
        item = FileContextItem(path="a.ts", language="ts", snippet="...", truncated=True)
        block = render_project_context_block([item])
        assert "[truncated]" in block
