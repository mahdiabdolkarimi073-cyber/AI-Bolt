"""Workspace file routes — controlled, validated access to project files.

Phase 9 expands the workspace routes to:
  * Resolve a project's on-disk root from the DB record (no client-supplied
    project_path).
  * List directory entries (lazy, one level at a time).
  * Create / rename / delete files and directories.
  * Search filenames and source text within a project.
  * Import a project from a ZIP archive with safe extraction.
  * Register an empty project.

All operations go through `app.filesystem` for path validation and
containment. Destructive operations require explicit confirmation flags.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import zipfile
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, status
from pydantic import BaseModel, Field

from app.config import workspace_root_path
from app.db import connect
from app.filesystem import (
    FilesystemError,
    EXCLUDED_DIR_NAMES,
    MAX_ARCHIVE_BYTES,
    MAX_DIR_ENTRIES,
    MAX_EXTRACTED_BYTES,
    MAX_EXTRACTED_FILES,
    MAX_SEARCH_RESULTS,
    MAX_SEARCH_FILE_BYTES,
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
from app.repositories import ProjectRepo, RecentProjectsRepo

import logging

logger = logging.getLogger("workspace_routes")

router = APIRouter(prefix="/workspace", tags=["workspace"])

LANG_MAP = {
    ".tsx": "tsx", ".ts": "ts", ".jsx": "jsx", ".js": "js",
    ".css": "css", ".json": "json", ".md": "md", ".html": "html",
    ".py": "py", ".svg": "svg", ".txt": "txt", ".yml": "yaml",
    ".yaml": "yaml", ".toml": "toml", ".sh": "shell", ".rs": "rust",
    ".go": "go", ".java": "java", ".c": "c", ".cpp": "cpp",
    ".sql": "sql", ".xml": "xml", ".ini": "ini", ".env": "ini",
}


def _language_for(path: Path) -> str:
    return LANG_MAP.get(path.suffix.lower(), "text")


def _resolve_project(project_id: str) -> tuple[dict, Path]:
    """Load a project record from the DB and resolve its on-disk root."""
    with connect() as conn:
        project = ProjectRepo.get(conn, project_id)
    if not project:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Project not found."})
    wp = project.get("workspacePath")
    if not wp:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"code": "project_not_imported", "message": "Project has no on-disk workspace. Import it first."},
        )
    root = project_root_on_disk(wp)
    return project, root


def _entry_node(entry: Path, root: Path) -> dict:
    rel = entry.relative_to(root).as_posix()
    if entry.is_dir():
        return {"id": rel, "name": entry.name, "type": "folder", "children": None}
    return {"id": rel, "name": entry.name, "type": "file", "language": _language_for(entry)}


# --- Directory listing (lazy: one level) ---

@router.get("/{project_id}/tree")
def list_tree(project_id: str, subpath: str = "", depth: int = 1):
    """List directory entries under `subpath`. depth=1 returns one level
    (children have children=null). depth>1 recursively expands folders up to
    `depth` levels. Excluded directories are included in the listing but their
    children are not auto-expanded."""
    logger.info("[WORKSPACE-DEBUG] backend_list_tree START project_id=%s subpath=%r depth=%s", project_id, subpath, depth)
    try:
        _safe_sub = validate_relative_path(subpath) if subpath else "."
    except FilesystemError as e:
        logger.warning("[WORKSPACE-DEBUG] backend_list_tree REJECT subpath=%r reason=%s", subpath, e.detail if hasattr(e, 'detail') else str(e))
        raise e
    _, root = _resolve_project(project_id)
    target = root if _safe_sub == "." else safe_resolve_in_project(root, _safe_sub)
    logger.info("[WORKSPACE-DEBUG] backend_list_tree RESOLVED project_id=%s root=%s target=%s exists=%s is_dir=%s",
                project_id, root, target, target.exists(), target.is_dir() if target.exists() else 'N/A')
    if not target.exists() or not target.is_dir():
        logger.warning("[WORKSPACE-DEBUG] backend_list_tree NOT_FOUND project_id=%s target=%s", project_id, target)
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Directory not found."})

    def build(dir_path: Path, current_depth: int) -> list[dict]:
        if current_depth <= 0:
            return []
        nodes: list[dict] = []
        try:
            entries = sorted(dir_path.iterdir(), key=lambda p: (not p.is_dir(), p.name.lower()))
        except PermissionError:
            return nodes
        count = 0
        for entry in entries:
            if count >= MAX_DIR_ENTRIES:
                break
            rel = entry.relative_to(root).as_posix()
            if entry.is_dir():
                children = build(entry, current_depth - 1) if current_depth > 1 else None
                nodes.append({"id": rel, "name": entry.name, "type": "folder", "children": children})
            else:
                nodes.append({"id": rel, "name": entry.name, "type": "file", "language": _language_for(entry)})
            count += 1
        return nodes

    result = build(target, max(1, min(depth, 4)))
    logger.info("[WORKSPACE-DEBUG] backend_list_tree OK project_id=%s subpath=%r child_count=%d", project_id, subpath, len(result))
    return result


# --- File read / write / delete ---

class FileWrite(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    content: str
    overwrite: bool = False


@router.get("/{project_id}/files")
def read_file(project_id: str, path: str):
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, path)
    if not target.exists() or not target.is_file():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "File not found."})
    check_file_size(target, MAX_SINGLE_FILE_BYTES)
    try:
        content = target.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        content = target.read_bytes().decode("utf-8", errors="replace")
    return {"path": validate_relative_path(path), "content": content, "language": _language_for(target)}


@router.get("/{project_id}/files/info")
def file_info(project_id: str, path: str):
    """Return metadata for a file: size, modified time, isText."""
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, path)
    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Not found."})
    stat = target.stat()
    return {
        "path": validate_relative_path(path),
        "size": stat.st_size,
        "modifiedAt": int(stat.st_mtime * 1000),
        "isDir": target.is_dir(),
        "isText": target.is_file() and is_text_file(target),
    }


@router.post("/{project_id}/files", status_code=status.HTTP_201_CREATED)
def write_file(project_id: str, body: FileWrite):
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, body.path)
    if target.exists() and not body.overwrite:
        raise HTTPException(
            status.HTTP_409_CONFLICT,
            detail={"code": "exists", "message": "File exists. Set overwrite=true to replace."},
        )
    if len(body.content.encode("utf-8")) > MAX_SINGLE_FILE_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "file_too_large", "message": f"File content exceeds {MAX_SINGLE_FILE_BYTES // 1024 // 1024}MB limit."},
        )
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body.content, encoding="utf-8")
    return {"path": validate_relative_path(body.path), "content": body.content, "language": _language_for(target)}


@router.delete("/{project_id}/files", status_code=status.HTTP_204_NO_CONTENT)
def delete_path(project_id: str, path: str, confirm: bool = False):
    if not confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "confirmation_required", "message": "Delete requires confirm=true."})
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, path)
    if not target.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Not found."})
    # Never allow deleting the project root via this endpoint.
    if target.resolve(strict=False) == root.resolve(strict=False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": "Cannot delete the project root."})
    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            os.remove(target)
    except OSError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "io_error", "message": str(exc)})


# --- Create directory / file, rename ---

class CreateDir(BaseModel):
    path: str = Field(min_length=1, max_length=512)


class CreateFile(BaseModel):
    path: str = Field(min_length=1, max_length=512)
    content: str = ""


class RenamePath(BaseModel):
    fromPath: str = Field(min_length=1, max_length=512)
    toPath: str = Field(min_length=1, max_length=512)
    overwrite: bool = False


@router.post("/{project_id}/dirs", status_code=status.HTTP_201_CREATED)
def create_directory(project_id: str, body: CreateDir):
    _, root = _resolve_project(project_id)
    target = safe_resolve_in_project(root, body.path)
    if target.exists():
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "exists", "message": "Path already exists."})
    target.mkdir(parents=True, exist_ok=False)
    return {"path": validate_relative_path(body.path), "type": "folder"}


@router.post("/{project_id}/rename")
def rename_path(project_id: str, body: RenamePath):
    _, root = _resolve_project(project_id)
    src = safe_resolve_in_project(root, body.fromPath)
    dst = safe_resolve_in_project(root, body.toPath)
    if not src.exists():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Source not found."})
    if dst.exists() and not body.overwrite:
        raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "exists", "message": "Destination exists. Set overwrite=true."})
    if dst.resolve(strict=False) == root.resolve(strict=False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": "Cannot rename onto the project root."})
    try:
        if dst.exists() and body.overwrite:
            if dst.is_dir():
                shutil.rmtree(dst)
            else:
                os.remove(dst)
        shutil.move(str(src), str(dst))
    except OSError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "io_error", "message": str(exc)})
    return {"fromPath": validate_relative_path(body.fromPath), "toPath": validate_relative_path(body.toPath)}


# --- Search ---

@router.get("/{project_id}/search")
def search_project(project_id: str, q: str, mode: str = "filename", limit: int = 50):
    """Search filenames (mode=filename) or source text (mode=content)."""
    query = q.strip()
    if not query:
        return {"results": [], "mode": mode, "total": 0}
    limit = max(1, min(limit, MAX_SEARCH_RESULTS))
    _, root = _resolve_project(project_id)
    results: list[dict] = []

    if mode == "filename":
        pat = re.compile(re.escape(query), re.IGNORECASE)
        for dirpath, dirnames, filenames in os.walk(root):
            # Prune excluded dirs during search.
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES]
            for fn in filenames:
                if pat.search(fn):
                    full = Path(dirpath) / fn
                    try:
                        rel = full.relative_to(root).as_posix()
                    except ValueError:
                        continue
                    results.append({"path": rel, "name": fn, "line": None, "match": fn})
                    if len(results) >= limit:
                        return {"results": results, "mode": mode, "total": len(results)}

    elif mode == "content":
        pat = re.compile(re.escape(query), re.IGNORECASE)
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDED_DIR_NAMES]
            for fn in filenames:
                if len(results) >= limit:
                    return {"results": results, "mode": mode, "total": len(results)}
                full = Path(dirpath) / fn
                try:
                    if full.stat().st_size > MAX_SEARCH_FILE_BYTES:
                        continue
                except OSError:
                    continue
                if not is_text_file(full):
                    continue
                try:
                    text = full.read_text(encoding="utf-8", errors="ignore")
                except OSError:
                    continue
                for i, line in enumerate(text.splitlines(), start=1):
                    if pat.search(line):
                        try:
                            rel = full.relative_to(root).as_posix()
                        except ValueError:
                            continue
                        snippet = line.strip()[:200]
                        results.append({"path": rel, "name": fn, "line": i, "match": snippet})
                        if len(results) >= limit:
                            return {"results": results, "mode": mode, "total": len(results)}
                        break  # one match per file for content search
    else:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_request", "message": "mode must be 'filename' or 'content'."})

    return {"results": results, "mode": mode, "total": len(results)}


# --- Project registration / import ---

class RegisterProject(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    workspacePath: str = Field(min_length=1, max_length=120)


@router.post("/register", status_code=status.HTTP_201_CREATED)
def register_project(body: RegisterProject):
    """Register an existing on-disk directory as a project. The directory must
    already exist under WORKSPACE_ROOT (created by import or create-empty)."""
    wp = validate_relative_name(body.workspacePath)
    root = project_root_on_disk(wp)
    if not root.exists() or not root.is_dir():
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Workspace directory not found on disk."})
    with connect() as conn:
        existing = ProjectRepo.get_by_workspace_path(conn, wp)
        if existing:
            raise HTTPException(
                status.HTTP_409_CONFLICT,
                detail={"code": "exists", "message": "A project is already registered for this workspace path."},
            )
        project = ProjectRepo.create(
            conn,
            name=body.name,
            path=wp,
            template="blank",
            workspace_path=wp,
            import_source="manual",
        )
    return project


class CreateEmptyProject(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    workspacePath: Optional[str] = None


@router.post("/create-empty", status_code=status.HTTP_201_CREATED)
def create_empty_project(body: CreateEmptyProject):
    """Create an empty project directory under WORKSPACE_ROOT and register it."""
    base = workspace_root_path()
    # Derive a safe directory name from the project name if not provided.
    raw = body.workspacePath or body.name
    safe = re.sub(r"[^A-Za-z0-9._-]+", "-", raw).strip("-._").lower() or "project"
    # Ensure uniqueness on disk.
    candidate = safe
    suffix = 1
    while (base / candidate).exists():
        suffix += 1
        candidate = f"{safe}-{suffix}"
    target = base / candidate
    target.mkdir(parents=True, exist_ok=False)
    with connect() as conn:
        project = ProjectRepo.create(
            conn,
            name=body.name,
            path=candidate,
            template="blank",
            workspace_path=candidate,
            import_source="empty",
        )
    return project


@router.post("/import-zip", status_code=status.HTTP_201_CREATED)
async def import_zip(name: str = "", file: UploadFile = File(...)):
    """Import a project from a ZIP archive. Safely extracts to a new directory
    under WORKSPACE_ROOT and registers a project record.

    Safety:
      * Rejects zip-slip (..), absolute, drive-letter, and UNC entry names.
      * Rejects symlink entries pointing outside the target root.
      * Enforces archive size, extracted size, file count, and per-file limits.
      * Cleans up the partially-extracted directory on any failure.
    """
    desired_name = name.strip() or (file.filename or "imported").rsplit(".", 1)[0]
    if len(desired_name) > 120:
        desired_name = desired_name[:120]

    # Read the archive into memory (bounded by MAX_ARCHIVE_BYTES).
    raw = await file.read()
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise HTTPException(
            status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail={"code": "archive_too_large", "message": f"Archive exceeds {MAX_ARCHIVE_BYTES // 1024 // 1024}MB limit."},
        )
    if not raw.startswith(b"PK"):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_archive", "message": "File is not a valid ZIP archive."})

    try:
        zf = zipfile.ZipFile(io.BytesIO(raw))
    except zipfile.BadZipFile:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_archive", "message": "Malformed ZIP archive."})

    if zf.testzip():
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_archive", "message": "Archive contains a corrupt entry."})

    # Determine the common top-level directory, if any. If all entries share a
    # single root folder, we extract under WORKSPACE_ROOT/<that name>. Otherwise
    # we create a new folder to hold the contents.
    entries = zf.infolist()
    if len(entries) > MAX_EXTRACTED_FILES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            detail={"code": "too_many_files", "message": f"Archive has more than {MAX_EXTRACTED_FILES} entries."},
        )

    names = [e.filename.replace("\\", "/") for e in entries]
    # Determine whether all entries share a single top-level directory.
    # A "top-level part" is the first segment of each non-empty path. We must
    # include directory entries that lack a trailing slash (e.g. "myproj" as
    # well as "myproj/") and file entries at the root ("README.md"). If every
    # entry's first segment is the same AND at least one entry has a deeper
    # path (second segment exists), then there is a single shared root folder.
    top_segments: set[str] = set()
    has_deeper = False
    for n in names:
        if not n:
            continue
        parts = [p for p in n.split("/") if p != ""]
        if not parts:
            continue
        top_segments.add(parts[0])
        if len(parts) > 1:
            has_deeper = True
    single_root = len(top_segments) == 1 and has_deeper

    base = workspace_root_path()
    if single_root:
        root_name = next(iter(top_segments))
    else:
        root_name = re.sub(r"[^A-Za-z0-9._-]+", "-", desired_name).strip("-._").lower() or "imported"

    # Ensure uniqueness on disk.
    candidate = root_name
    suffix = 1
    while (base / candidate).exists():
        suffix += 1
        candidate = f"{root_name}-{suffix}"
    extract_root = base / candidate
    extract_root.mkdir(parents=True, exist_ok=False)

    total_extracted = 0
    file_count = 0
    try:
        for info in entries:
            if info.is_dir():
                # Validate the directory name is safe.
                _validate_zip_entry(info.filename, extract_root)
                target = _zip_target(info.filename, extract_root, single_root, root_name)
                target.mkdir(parents=True, exist_ok=True)
                continue
            _validate_zip_entry(info.filename, extract_root)
            target = _zip_target(info.filename, extract_root, single_root, root_name)
            if info.file_size > MAX_SINGLE_FILE_BYTES:
                raise FilesystemError(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"code": "file_too_large", "message": f"Entry {info.filename} exceeds {MAX_SINGLE_FILE_BYTES // 1024 // 1024}MB."},
                )
            total_extracted += info.file_size
            if total_extracted > MAX_EXTRACTED_BYTES:
                raise FilesystemError(
                    status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                    detail={"code": "extracted_too_large", "message": f"Total extracted size exceeds {MAX_EXTRACTED_BYTES // 1024 // 1024}MB."},
                )
            file_count += 1
            if file_count > MAX_EXTRACTED_FILES:
                raise FilesystemError(
                    status.HTTP_400_BAD_REQUEST,
                    detail={"code": "too_many_files", "message": f"More than {MAX_EXTRACTED_FILES} files in archive."},
                )
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst, length=1024 * 1024)
    except FilesystemError as exc:
        shutil.rmtree(extract_root, ignore_errors=True)
        raise exc
    except Exception:
        shutil.rmtree(extract_root, ignore_errors=True)
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "extract_failed", "message": "Extraction failed. Archive may be malformed or unsafe."})

    # Register the project in the DB.
    with connect() as conn:
        existing = ProjectRepo.get_by_workspace_path(conn, candidate)
        if existing:
            shutil.rmtree(extract_root, ignore_errors=True)
            raise HTTPException(status.HTTP_409_CONFLICT, detail={"code": "exists", "message": "A project is already registered for this workspace."})
        project = ProjectRepo.create(
            conn,
            name=desired_name,
            path=candidate,
            template="blank",
            workspace_path=candidate,
            import_source="zip",
        )
    return project


def _validate_zip_entry(member_name: str, extract_root: Path) -> None:
    """Reject zip-slip, absolute, drive-letter, UNC, and symlink entries."""
    if not member_name:
        raise FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_entry", "message": "Empty archive entry name."})
    norm = member_name.replace("\\", "/")
    if norm.startswith("/") or _DRIVE_RE.match(norm) or _UNC_RE.match(norm):
        raise FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_entry", "message": f"Unsafe entry path: {member_name}"})
    for part in norm.split("/"):
        if part == "..":
            raise FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_entry", "message": "Path traversal in archive entry."})
        if any(ord(c) < 32 for c in part):
            raise FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_entry", "message": "Invalid characters in archive entry."})


def _zip_target(member_name: str, extract_root: Path, single_root: bool, root_name: str) -> Path:
    """Compute the on-disk target for a zip entry, stripping a common top-level
    dir if present."""
    norm = member_name.replace("\\", "/")
    if single_root:
        parts = [p for p in norm.split("/") if p != ""]
        if parts and parts[0] == root_name:
            rel_parts = parts[1:]
        else:
            rel_parts = parts
        rel = "/".join(rel_parts)
    else:
        rel = norm
    target = extract_root
    for part in rel.split("/"):
        if part in ("", "."):
            continue
        target = target / part
    # Containment check.
    try:
        if os.path.commonpath([str(target.resolve(strict=False)), str(extract_root.resolve(strict=False))]) != str(extract_root.resolve(strict=False)):
            raise FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_entry", "message": "Entry escapes extraction root."})
    except ValueError:
        raise FilesystemError(status.HTTP_400_BAD_REQUEST, detail={"code": "invalid_entry", "message": "Entry escapes extraction root."})
    return target


_DRIVE_RE = re.compile(r"^[a-zA-Z]:")
_UNC_RE = re.compile(r"^[\\/]{2}")


# --- Recent projects ---

@router.get("/recent/list")
def list_recent_projects():
    with connect() as conn:
        return RecentProjectsRepo.list(conn)


@router.delete("/recent/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def remove_from_recent(project_id: str):
    """Remove a project from the recent list WITHOUT deleting its files."""
    with connect() as conn:
        RecentProjectsRepo.remove(conn, project_id)


# --- Delete project files (separate from removing the DB record) ---

@router.delete("/{project_id}/files-on-disk", status_code=status.HTTP_204_NO_CONTENT)
def delete_project_files(project_id: str, confirm: bool = False):
    """Delete the entire on-disk project directory. This is destructive and
    separate from removing the DB record. Requires confirm=true."""
    if not confirm:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "confirmation_required", "message": "Pass confirm=true to delete project files on disk."})
    project, root = _resolve_project(project_id)
    # Never delete the workspace root itself.
    ws_root = workspace_root_path()
    if root.resolve(strict=False) == ws_root.resolve(strict=False):
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail={"code": "forbidden", "message": "Refusing to delete the workspace root."})
    try:
        shutil.rmtree(root)
    except OSError as exc:
        raise HTTPException(status.HTTP_500_INTERNAL_SERVER_ERROR, detail={"code": "io_error", "message": str(exc)})
