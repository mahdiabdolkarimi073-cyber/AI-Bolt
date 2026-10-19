"""Tests for the centralized filesystem security service.

Covers: path traversal, absolute/drive/UNC rejection, symlink escapes,
project-root containment, name validation, file-size limits, excluded dirs.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi import HTTPException

from app.filesystem import (
    EXCLUDED_DIR_NAMES,
    MAX_SINGLE_FILE_BYTES,
    check_file_size,
    ensure_within_project,
    is_excluded_dir,
    is_text_file,
    project_root_on_disk,
    safe_resolve_in_project,
    validate_relative_name,
    validate_relative_path,
)


# --- validate_relative_name ---

class TestValidateRelativeName:
    def test_accepts_simple_name(self):
        assert validate_relative_name("hello.ts") == "hello.ts"

    def test_rejects_empty(self):
        with pytest.raises(HTTPException) as exc:
            validate_relative_name("")
        assert exc.value.status_code == 400

    def test_rejects_path_separators(self):
        with pytest.raises(HTTPException):
            validate_relative_name("a/b")
        with pytest.raises(HTTPException):
            validate_relative_name("a\\b")

    def test_rejects_dot_and_dotdot(self):
        with pytest.raises(HTTPException):
            validate_relative_name(".")
        with pytest.raises(HTTPException):
            validate_relative_name("..")

    def test_rejects_control_chars(self):
        with pytest.raises(HTTPException):
            validate_relative_name("a\x00b")


# --- validate_relative_path ---

class TestValidateRelativePath:
    def test_accepts_simple_relative(self):
        assert validate_relative_path("src/App.tsx") == "src/App.tsx"

    def test_normalizes_backslashes(self):
        assert validate_relative_path("src\\App.tsx") == "src/App.tsx"

    def test_rejects_traversal(self):
        with pytest.raises(HTTPException) as exc:
            validate_relative_path("../escape")
        assert exc.value.status_code == 400

    def test_rejects_traversal_mid_path(self):
        with pytest.raises(HTTPException):
            validate_relative_path("src/../../escape")

    def test_rejects_absolute_unix(self):
        with pytest.raises(HTTPException):
            validate_relative_path("/etc/passwd")

    def test_rejects_drive_letter(self):
        with pytest.raises(HTTPException):
            validate_relative_path("C:/Windows/System32")

    def test_rejects_unc_path(self):
        with pytest.raises(HTTPException):
            validate_relative_path("//server/share/file")

    def test_rejects_empty(self):
        with pytest.raises(HTTPException):
            validate_relative_path("")

    def test_strips_dot_segments(self):
        assert validate_relative_path("./src/./App.tsx") == "src/App.tsx"


# --- project_root_on_disk ---

class TestProjectRootOnDisk:
    def test_resolves_existing(self, env: Path):
        (env / "myproj").mkdir()
        root = project_root_on_disk("myproj")
        assert root == (env / "myproj").resolve()

    def test_rejects_traversal_in_workspace_path(self, env: Path):
        with pytest.raises(HTTPException):
            project_root_on_disk("..")

    def test_rejects_separator_in_workspace_path(self, env: Path):
        with pytest.raises(HTTPException):
            project_root_on_disk("a/b")
        with pytest.raises(HTTPException):
            project_root_on_disk("a\\b")


# --- safe_resolve_in_project + symlink escapes ---

class TestSafeResolve:
    def test_resolves_nested_file(self, project_dir: Path):
        (project_dir / "src" / "App.tsx").parent.mkdir(parents=True)
        (project_dir / "src" / "App.tsx").write_text("x")
        p = safe_resolve_in_project(project_dir, "src/App.tsx")
        assert p.name == "App.tsx"

    def test_rejects_traversal(self, project_dir: Path):
        with pytest.raises(HTTPException) as exc:
            safe_resolve_in_project(project_dir, "../escape.txt")
        assert exc.value.status_code == 400

    @pytest.mark.skipif(sys.platform == "win32", reason="symlink behavior differs on Windows")
    def test_rejects_symlink_escape(self, project_dir: Path, env: Path):
        # Create a target outside the project root.
        outside = env / "outside-target.txt"
        outside.write_text("secret")
        link = project_dir / "escape.link"
        os.symlink(outside, link)
        with pytest.raises(HTTPException) as exc:
            safe_resolve_in_project(project_dir, "escape.link")
        assert exc.value.status_code == 403

    @pytest.mark.skipif(sys.platform == "win32", reason="symlink behavior differs on Windows")
    def test_allows_symlink_inside_project(self, project_dir: Path):
        (project_dir / "real.txt").write_text("ok")
        link = project_dir / "alias.link"
        # Relative symlink target stays inside the project.
        os.symlink("real.txt", link)
        p = safe_resolve_in_project(project_dir, "alias.link")
        assert p.exists()

    @pytest.mark.skipif(sys.platform == "win32", reason="symlink behavior differs on Windows")
    def test_rejects_absolute_symlink_escape(self, project_dir: Path, tmp_path: Path):
        outside = tmp_path / "abs-target.txt"
        outside.write_text("x")
        link = project_dir / "abs.link"
        os.symlink(outside, link)
        with pytest.raises(HTTPException) as exc:
            safe_resolve_in_project(project_dir, "abs.link")
        assert exc.value.status_code == 403


# --- ensure_within_project ---

class TestEnsureWithinProject:
    def test_accepts_inside(self, project_dir: Path):
        f = project_dir / "a.txt"
        f.write_text("x")
        assert ensure_within_project(f, project_dir) == f

    def test_rejects_outside(self, project_dir: Path, env: Path):
        outside = env / "outside.txt"
        outside.write_text("x")
        with pytest.raises(HTTPException):
            ensure_within_project(outside, project_dir)


# --- check_file_size / is_text_file ---

class TestFileChecks:
    def test_check_file_size_ok(self, project_dir: Path):
        f = project_dir / "small.txt"
        f.write_text("x" * 100)
        check_file_size(f)  # no raise

    def test_check_file_size_rejects_large(self, project_dir: Path):
        f = project_dir / "big.txt"
        f.write_bytes(b"\x00" * (MAX_SINGLE_FILE_BYTES + 1))
        with pytest.raises(HTTPException) as exc:
            check_file_size(f)
        assert exc.value.status_code == 413

    def test_is_text_file_true(self, project_dir: Path):
        f = project_dir / "t.txt"
        f.write_text("hello world")
        assert is_text_file(f) is True

    def test_is_text_file_false_for_binary(self, project_dir: Path):
        f = project_dir / "bin.dat"
        f.write_bytes(b"\x00\x01\x02\x00\x04")
        assert is_text_file(f) is False


# --- excluded dirs ---

class TestExcludedDirs:
    def test_node_modules_excluded(self):
        assert is_excluded_dir("node_modules") is True

    def test_git_excluded(self):
        assert is_excluded_dir(".git") is True

    def test_normal_dir_not_excluded(self):
        assert is_excluded_dir("src") is False

    def test_excluded_set_contains_common_build_dirs(self):
        for d in ("node_modules", ".git", "dist", "build", "__pycache__", ".venv"):
            assert d in EXCLUDED_DIR_NAMES
