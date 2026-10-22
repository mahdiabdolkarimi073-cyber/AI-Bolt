"""Phase 12 — file snapshots and AI change-proposal application.

Exposes:
  GET  /workspace/{project_id}/snapshots/{rel_path}  — latest snapshot for a file
  POST /workspace/{project_id}/snapshots/{rel_path}  — manually save a snapshot
  POST /workspace/{project_id}/restore/{rel_path}    — restore from snapshot
  POST /workspace/{project_id}/apply-changes         — apply AI-proposed changes (with snapshot)
  GET  /workspace/{project_id}/proposals             — list pending proposals
  POST /workspace/{project_id}/proposals/{id}/dismiss — dismiss a proposal

These routes integrate with the existing workspace file service: apply-changes
reads+writes through the same path-validation helpers used by workspace_routes.
A snapshot is saved automatically before any overwrite so the user can recover.
"""
from __future__ import annotations

import uuid
from typing import Optional
from pathlib import Path

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.db import connect
from app.filesystem import safe_resolve_in_project, validate_relative_path
from app.repositories import ProjectRepo
from app.utils import now_ms

router = APIRouter(prefix="/workspace", tags=["snapshots"])

MAX_SNAPSHOT_BYTES = 512 * 1024  # 512 KB per snapshot — not a full VCS


# --- helpers ---

def _resolve_project(project_id: str) -> tuple[dict, Path]:
    with connect() as conn:
        project = ProjectRepo.get(conn, project_id)
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Project not found."})
    from app.filesystem import project_root_on_disk
    root = project_root_on_disk(project.get("workspacePath") or "")
    if not root.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "project_not_imported", "message": "Project directory not found on disk."})
    return project, root


# --- Snapshot helpers (used by workspace_routes too) ---

def save_snapshot(project_id: str, rel_path: str, content: str, note: str = "") -> str:
    """Best-effort: save a snapshot of content. Returns snapshot id or '' on error."""
    if len(content.encode("utf-8")) > MAX_SNAPSHOT_BYTES:
        return ""  # skip for very large files
    snap_id = f"snap-{uuid.uuid4().hex[:12]}"
    try:
        with connect() as conn:
            conn.execute(
                """
                INSERT INTO file_snapshots (id, project_id, rel_path, content, content_chars, created_at, note)
                VALUES (?,?,?,?,?,?,?)
                ON CONFLICT(project_id, rel_path) DO UPDATE SET
                  id = excluded.id,
                  content = excluded.content,
                  content_chars = excluded.content_chars,
                  created_at = excluded.created_at,
                  note = excluded.note
                """,
                (snap_id, project_id, rel_path, content, len(content), now_ms(), note),
            )
    except Exception:
        return ""
    return snap_id


def get_snapshot(project_id: str, rel_path: str) -> Optional[dict]:
    try:
        with connect() as conn:
            row = conn.execute(
                "SELECT id, rel_path, content, content_chars, created_at, note FROM file_snapshots WHERE project_id=? AND rel_path=?",
                (project_id, rel_path),
            ).fetchone()
    except Exception:
        return None
    if not row:
        return None
    return dict(row)


# --- Routes ---

@router.get("/{project_id}/snapshots/{rel_path:path}")
def get_file_snapshot(project_id: str, rel_path: str):
    """Return the latest snapshot for a file (the content before the last write)."""
    snap = get_snapshot(project_id, rel_path)
    if not snap:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "No snapshot for this file."})
    return snap


class SaveSnapshotBody(BaseModel):
    note: str = ""


@router.post("/{project_id}/snapshots/{rel_path:path}", status_code=status.HTTP_201_CREATED)
def create_snapshot(project_id: str, rel_path: str, body: SaveSnapshotBody):
    """Manually save a snapshot of the current on-disk content."""
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, rel_path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "File not found."})
    try:
        content = target.read_text(encoding="utf-8", errors="replace")
    except OSError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "io_error", "message": str(exc)})
    snap_id = save_snapshot(project_id, rel_path, content, body.note)
    if not snap_id:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "snapshot_failed", "message": "File too large to snapshot."})
    return {"snapshotId": snap_id, "relPath": rel_path, "chars": len(content)}


@router.post("/{project_id}/restore/{rel_path:path}")
def restore_snapshot(project_id: str, rel_path: str):
    """Restore a file to its last snapshot. The current on-disk content is lost."""
    snap = get_snapshot(project_id, rel_path)
    if not snap:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "No snapshot to restore."})
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, rel_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        target.write_text(snap["content"], encoding="utf-8")
    except OSError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "io_error", "message": str(exc)})
    return {"relPath": rel_path, "restored": True, "chars": snap["content_chars"]}


# --- Apply-changes ---

class ProposedChange(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    description: str = ""
    original: str = ""
    updated: str = ""


class ApplyChangesBody(BaseModel):
    changes: list[ProposedChange] = Field(min_length=1, max_length=50)
    diagnosisId: Optional[str] = None
    saveSnapshots: bool = True


class ApplyResult(BaseModel):
    applied: list[dict] = []
    skipped: list[dict] = []


@router.post("/{project_id}/apply-changes", response_model=ApplyResult)
def apply_changes(project_id: str, body: ApplyChangesBody):
    """Apply AI-proposed file changes after user approval.

    For each change:
    1. Save a snapshot of the existing file (if saveSnapshots=True).
    2. Read the current file.
    3. Replace `original` with `updated` (or replace the whole file if original is empty).
    4. Write the result back via the same safe_resolve path.

    Changes that fail individually are reported in `skipped` — the rest still apply.
    """
    _, root = _resolve_project(project_id)
    applied: list[dict] = []
    skipped: list[dict] = []

    for change in body.changes:
        rel = change.path
        try:
            target = safe_resolve_in_project(root, rel)
        except HTTPException as exc:
            skipped.append({"path": rel, "reason": "path_rejected", "detail": str(exc.detail)})
            continue

        # Read existing content.
        if target.exists() and target.is_file():
            try:
                existing = target.read_text(encoding="utf-8", errors="replace")
            except OSError:
                skipped.append({"path": rel, "reason": "read_error"})
                continue
            # Snapshot before overwrite.
            if body.saveSnapshots:
                save_snapshot(project_id, rel, existing, note=f"before apply {body.diagnosisId or ''}")
        else:
            existing = ""

        # Compute new content.
        if change.original:
            if change.original not in existing:
                skipped.append({"path": rel, "reason": "original_not_found",
                                "detail": "The snippet to replace was not found in the file. It may have already been changed."})
                continue
            new_content = existing.replace(change.original, change.updated, 1)
        else:
            # No original snippet → replace the entire file.
            new_content = change.updated

        # Write.
        try:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(new_content, encoding="utf-8")
        except OSError as exc:
            skipped.append({"path": rel, "reason": "write_error", "detail": str(exc)})
            continue

        # Record the proposal as applied.
        if body.diagnosisId:
            try:
                with connect() as conn:
                    conn.execute(
                        """
                        INSERT INTO change_proposals
                          (id, project_id, diagnosis_id, rel_path, description,
                           original_snippet, updated_snippet, status, created_at, applied_at)
                        VALUES (?,?,?,?,?,?,?,'applied',?,?)
                        """,
                        (f"cp-{uuid.uuid4().hex[:10]}", project_id, body.diagnosisId,
                         rel, change.description, change.original, change.updated,
                         now_ms(), now_ms()),
                    )
            except Exception:
                pass

        applied.append({"path": rel, "chars": len(new_content)})

    return ApplyResult(applied=applied, skipped=skipped)


# --- Proposals list ---

@router.get("/{project_id}/proposals")
def list_proposals(project_id: str, status_filter: Optional[str] = None):
    try:
        with connect() as conn:
            if status_filter:
                rows = conn.execute(
                    "SELECT * FROM change_proposals WHERE project_id=? AND status=? ORDER BY created_at DESC LIMIT 100",
                    (project_id, status_filter),
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM change_proposals WHERE project_id=? ORDER BY created_at DESC LIMIT 100",
                    (project_id,),
                ).fetchall()
    except Exception:
        return {"proposals": []}
    return {"proposals": [dict(r) for r in rows]}


@router.post("/{project_id}/proposals/{proposal_id}/dismiss")
def dismiss_proposal(project_id: str, proposal_id: str):
    with connect() as conn:
        result = conn.execute(
            "UPDATE change_proposals SET status='dismissed' WHERE id=? AND project_id=?",
            (proposal_id, project_id),
        )
    if result.rowcount == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Proposal not found."})
    return {"id": proposal_id, "status": "dismissed"}
