"""Workspace file routes — controlled, validated access to project files."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.config import workspace_root_path
from app.security import safe_resolve

router = APIRouter(prefix="/workspace", tags=["workspace"])

LANG_MAP = {
    ".tsx": "tsx", ".ts": "ts", ".jsx": "jsx", ".js": "js",
    ".css": "css", ".json": "json", ".md": "md", ".html": "html",
    ".py": "py", ".svg": "svg", ".txt": "txt",
}


class FileWrite(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    content: str
    overwrite: bool = False


def _language_for(path: Path) -> str:
    return LANG_MAP.get(path.suffix.lower(), "text")


@router.get("/{project_id}/tree")
def list_tree(project_id: str, project_path: str = ""):
    """Return a nested file tree for a project directory.

    NOTE: in this phase the frontend does not yet know the on-disk project_path,
    so this endpoint accepts it as a query param. A future phase will look up
    the path from the project record.
    """
    if not project_path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "project_path query param is required")
    root = safe_resolve(project_path, ".")
    if not root.exists() or not root.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Project directory not found")

    def build(dir_path: Path) -> list[dict]:
        nodes: list[dict] = []
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return nodes
        for entry in entries:
            if entry.name in {".git", "node_modules", "__pycache__", ".venv"}:
                continue
            if entry.is_dir():
                nodes.append({
                    "id": str(entry.relative_to(root)),
                    "name": entry.name,
                    "type": "folder",
                    "children": build(entry),
                })
            else:
                nodes.append({
                    "id": str(entry.relative_to(root)),
                    "name": entry.name,
                    "type": "file",
                    "language": _language_for(entry),
                })
        return nodes

    return build(root)


@router.get("/{project_id}/files")
def read_file(project_id: str, path: str, project_path: str = ""):
    if not project_path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "project_path query param is required")
    target = safe_resolve(project_path, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = target.read_bytes().decode("utf-8", errors="replace")
    return {"path": path, "content": content, "language": _language_for(target)}


@router.post("/{project_id}/files", status_code=status.HTTP_201_CREATED)
def write_file(project_id: str, body: FileWrite, project_path: str = ""):
    if not project_path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "project_path query param is required")
    target = safe_resolve(project_path, body.path)
    if target.exists() and not body.overwrite:
        raise HTTPException(status.HTTP_409_CONFLICT, "File exists. Set overwrite=true to replace.")
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return {"path": body.path, "content": body.content, "language": _language_for(target)}


@router.delete("/{project_id}/files", status_code=status.HTTP_204_NO_CONTENT)
def delete_file(project_id: str, path: str, project_path: str = "", confirm: bool = False):
    if not confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Delete requires confirm=true.")
    if not project_path:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "project_path query param is required")
    target = safe_resolve(project_path, path)
    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, "File not found")
    if target.is_dir():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Refusing to delete a directory.")
    os.remove(target)
