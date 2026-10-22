"""Security helpers for workspace path validation.

All file operations are confined to the configured WORKSPACE_ROOT. Paths are
resolved to absolute form and checked against the root. Traversal attempts
(`..`) that escape the root are rejected.
"""
from __future__ import annotations

from pathlib import Path

from fastapi import HTTPException, status

from app.config import workspace_root_path


def safe_resolve(project_path: str, rel: str) -> Path:
    """Resolve `rel` inside the workspace root and verify containment.

    `project_path` is a subdirectory name under the workspace root (as stored
    on the project record). `rel` is a relative path inside that project.
    """
    root = workspace_root_path()
    # project_path itself must be a simple name (no traversal)
    proj = Path(project_path)
    if proj.is_absolute() or any(p == ".." for p in proj.parts):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid project path.")

    base = (root / proj).resolve()
    if not str(base).startswith(str(root)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Project path escapes workspace root.")

    target = (base / rel).resolve()
    if not str(target).startswith(str(base)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path traversal is not allowed.")
    return target


def ensure_within_root(path: Path) -> Path:
    """Verify a resolved path stays inside the workspace root."""
    root = workspace_root_path()
    p = path.resolve()
    if not str(p).startswith(str(root)):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Path escapes workspace root.")
    return p
