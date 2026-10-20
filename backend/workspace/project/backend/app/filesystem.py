"""Centralized filesystem service for workspace operations.

All file operations on imported projects go through this module. It enforces:

  * Paths are resolved and confined to a registered project's on-disk root.
  * No `..` traversal, absolute paths, drive letters, or UNC paths escape.
  * Symlinks/junctions that point outside the project root are rejected.
  * The workspace root itself can never be deleted.
  * File-size and count limits are enforced.

The trust boundary is local-only: the FastAPI backend listens on 127.0.0.1
and is intended for a single developer's machine. These checks are defense in
depth, not a substitute for OS-level permissions.
"""
from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Optional

from fastapi import HTTPException, status

from app.config import workspace_root_path


# --- Limits (tuned for a personal code IDE on an 8 GB machine) ---

MAX_ARCHIVE_BYTES = 256 * 1024 * 1024          # 256 MB uploaded zip
MAX_EXTRACTED_BYTES = 512 * 1024 * 1024        # 512 MB total extracted
MAX_EXTRACTED_FILES = 20_000
MAX_SINGLE_FILE_BYTES = 16 * 1024 * 1024       # 16 MB per file
MAX_DIR_ENTRIES = 5_000                         # per directory listing
MAX_SEARCH_RESULTS = 200
MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024        # don't read files > 2MB for text search

# Directories skipped by broad traversal / search (never by the explorer itself
# unless explicitly requested). Centralized so the Agent and search agree.
EXCLUDED_DIR_NAMES: frozenset[str] = frozenset({
    "node_modules", ".git", "dist", "build", ".next",
    "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
    ".bolt", ".idea", ".vscode", "target", ".gradle",
})

# Drive-letter (Windows) and UNC path patterns.
_DRIVE_RE = re.compile(r"^[a-zA-Z]:")
_UNC_RE = re.compile(r"^[\\/]{2}")


class FilesystemError(HTTPException):
    """Typed filesystem error mapped to an HTTP response."""


def _bad(msg: str, code: str = "invalid_path") -> FilesystemError:
    return FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": code, "message": msg})


def _forbidden(msg: str) -> FilesystemError:
    return FilesystemError(status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": msg})


def _not_found(msg: str) -> FilesystemError:
    return FilesystemError(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": msg})


def validate_relative_name(name: str) -> str:
    """Validate a single file/directory name (no path separators)."""
    if not name or len(name) > 255:
        raise _bad("Name must be 1–255 characters.", "invalid_name")
    if "/" in name or "\\" in name:
        raise _bad("Name must not contain path separators.", "invalid_name")
    if name in {".", ".."}:
        raise _bad("Reserved name.", "invalid_name")
    # Reject control characters and null bytes.
    if any(ord(c) < 32 for c in name):
        raise _bad("Name contains invalid characters.", "invalid_name")
    return name


def validate_relative_path(rel: str) -> str:
    """Validate a relative path inside a project. Rejects traversal, absolute,
    drive-letter, and UNC forms. Returns the normalized forward-slash path."""
    if not rel:
        raise _bad("Path is required.")
    # Normalize backslashes to forward slashes.
    norm = rel.replace("\\", "/")
    if _DRIVE_RE.match(norm) or _UNC_RE.match(norm):
        raise _bad("Absolute, drive-letter, and UNC paths are not allowed.")
    if norm.startswith("/"):
        raise _bad("Absolute paths are not allowed.")
    parts = norm.split("/")
    cleaned: list[str] = []
    for part in parts:
        if part in ("", "."):
            continue
        if part == "..":
            raise _bad("Path traversal (..) is not allowed.")
        if any(ord(c) < 32 for c in part):
            raise _bad("Path contains invalid characters.", "invalid_path")
        cleaned.append(part)
    if not cleaned:
        raise _bad("Path is required.")
    return "/".join(cleaned)


def project_root_on_disk(workspace_path: str) -> Path:
    """Resolve a project's on-disk root under WORKSPACE_ROOT.

    `workspace_path` is the directory name stored on the project record. It
    must be a single path segment (no separators, no traversal)."""
    if not workspace_path:
        raise _bad("Project has no on-disk workspace path.", "project_not_imported")
    if "/" in workspace_path or "\\" in workspace_path:
        raise _bad("Invalid project workspace path.", "invalid_path")
    if workspace_path in {".", ".."}:
        raise _bad("Invalid project workspace path.", "invalid_path")
    if _DRIVE_RE.match(workspace_path) or _UNC_RE.match(workspace_path):
        raise _bad("Invalid project workspace path.", "invalid_path")
    root = workspace_root_path()
    base = (root / workspace_path).resolve()
    # Containment check using os.path commonpath for robustness.
    if os.path.commonpath([str(base), str(root)]) != str(root):
        raise _forbidden("Project path escapes workspace root.")
    return base


def safe_resolve_in_project(project_root: Path, rel: str) -> Path:
    """Resolve `rel` inside `project_root` and verify containment + no symlink
    escape. Rechecks immediately before use."""
    safe_rel = validate_relative_path(rel)
    # Build the target without following symlinks, then verify each component.
    target = project_root
    for part in safe_rel.split("/"):
        target = target / part
        # Resolve this component's real location without resolving the whole
        # path (which could follow a later symlink legitimately inside root).
        try:
            real = target.resolve(strict=False)
        except (OSError, RuntimeError):
            raise _bad("Could not resolve path.", "invalid_path")
        # The resolved component must still be under the project root.
        try:
            if os.path.commonpath([str(real), str(project_root)]) != str(project_root):
                raise _forbidden("Path escapes the project directory (symlink or traversal).")
        except ValueError:
            raise _forbidden("Path escapes the project directory.")
        # Reject if this component is a symlink pointing outside root.
        if target.is_symlink():
            link_target = os.readlink(target)
            if os.path.isabs(link_target):
                raise _forbidden("Absolute symlinks are not allowed inside a project.")
            resolved_link = (target.parent / link_target).resolve(strict=False)
            try:
                if os.path.commonpath([str(resolved_link), str(project_root)]) != str(project_root):
                    raise _forbidden("Symlink points outside the project directory.")
            except ValueError:
                raise _forbidden("Symlink points outside the project directory.")
    return target


def ensure_within_project(path: Path, project_root: Path) -> Path:
    """Verify a resolved path stays inside the project root."""
    try:
        if os.path.commonpath([str(path.resolve(strict=False)), str(project_root)]) != str(project_root):
            raise _forbidden("Path escapes the project directory.")
    except ValueError:
        raise _forbidden("Path escapes the project directory.")
    return path


def is_excluded_dir(name: str) -> bool:
    return name in EXCLUDED_DIR_NAMES


def check_file_size(path: Path, limit: int = MAX_SINGLE_FILE_BYTES) -> None:
    try:
        size = path.stat().st_size
    except OSError:
        raise _not_found("File not found or inaccessible.")
    if size > limit:
        raise FilesystemError(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "file_too_large", "message": f"File exceeds {limit // 1024 // 1024}MB limit."},
        )


def is_text_file(path: Path) -> bool:
    """Heuristic: a file is text if it has no NUL bytes in its first chunk."""
    try:
        with open(path, "rb") as f:
            chunk = f.read(4096)
    except OSError:
        return False
    return b"\x00" not in chunk
