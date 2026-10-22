"""REST endpoints for persistent memory and project knowledge base.

Routes follow the existing project conventions (see routes.py, connection_routes.py):
  - Pydantic models for request bodies with length limits.
  - `with connect() as conn` for DB access.
  - 404 for missing records, 400 for validation errors.
  - List endpoints return {'items': [...], 'total': N} and accept pagination.

These endpoints expose only non-secret data. The repos refuse to persist
content that matches credential patterns (defense in depth).
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, status, Query
from pydantic import BaseModel, Field

from app.db import connect
from app.memory_repos import (
    MemoryRepo,
    KnowledgeRepo,
    MEMORY_TYPES,
    KNOWLEDGE_CATEGORIES,
    DEFAULT_LIST_LIMIT,
    MAX_LIST_LIMIT,
)


router = APIRouter(prefix="/memory", tags=["memory"])


# --- Memory ---

class MemoryCreate(BaseModel):
    type: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=16000)
    projectId: Optional[str] = Field(default=None, max_length=120)
    tags: Optional[list[str]] = None
    importance: int = Field(default=0, ge=-5, le=10)


class MemoryUpdate(BaseModel):
    type: Optional[str] = None
    title: Optional[str] = Field(default=None, max_length=240)
    content: Optional[str] = Field(default=None, max_length=16000)
    projectId: Optional[str] = None
    tags: Optional[list[str]] = None
    importance: Optional[int] = Field(default=None, ge=-5, le=10)
    active: Optional[bool] = None


@router.get("")
def list_memories(
    projectId: Optional[str] = Query(default=None, description="Scope: 'all' for everything, omit for personal/global, or a project id"),
    type: Optional[str] = None,
    search: Optional[str] = Query(default=None, max_length=500),
    activeOnly: bool = True,
    limit: int = Query(default=DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT),
    offset: int = Query(default=0, ge=0),
):
    # `projectId=all` is the explicit "no filter" sentinel.
    pid: Optional[str] = ...
    if projectId == "all":
        pid = ""  # signals "no project filter" in the repo
    elif projectId is None:
        pid = None
    else:
        pid = projectId
    with connect() as conn:
        try:
            return MemoryRepo.list(
                conn,
                project_id=pid,
                type_filter=type,
                active_only=activeOnly,
                search=search,
                limit=limit,
                offset=offset,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.post("", status_code=status.HTTP_201_CREATED)
def create_memory(body: MemoryCreate):
    with connect() as conn:
        try:
            return MemoryRepo.create(
                conn,
                type=body.type,
                title=body.title,
                content=body.content,
                project_id=body.projectId,
                tags=body.tags,
                importance=body.importance,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@router.get("/types")
def list_memory_types():
    return {"types": list(MEMORY_TYPES)}


@router.get("/{mid}")
def get_memory(mid: str):
    with connect() as conn:
        m = MemoryRepo.get(conn, mid)
        if not m:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
        return m


@router.patch("/{mid}")
def update_memory(mid: str, body: MemoryUpdate):
    with connect() as conn:
        try:
            m = MemoryRepo.update(
                conn,
                mid,
                type=body.type,
                title=body.title,
                content=body.content,
                project_id=body.projectId,  # type: ignore[arg-type]
                tags=body.tags if body.tags is not None else ...,  # type: ignore[arg-type]
                importance=body.importance,
                active=body.active,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
        if not m:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")
        return m


@router.delete("/{mid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_memory(mid: str):
    with connect() as conn:
        if not MemoryRepo.remove(conn, mid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Memory not found")


# --- Knowledge ---

kb_router = APIRouter(prefix="/knowledge", tags=["knowledge"])


class KnowledgeCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    content: str = Field(min_length=1, max_length=16000)
    category: str = Field(min_length=1, max_length=40)
    projectId: Optional[str] = Field(default=None, max_length=120)
    tags: Optional[list[str]] = None
    source: Optional[str] = Field(default=None, max_length=240)


class KnowledgeUpdate(BaseModel):
    title: Optional[str] = Field(default=None, max_length=240)
    content: Optional[str] = Field(default=None, max_length=16000)
    category: Optional[str] = None
    projectId: Optional[str] = None
    tags: Optional[list[str]] = None
    source: Optional[str] = None
    active: Optional[bool] = None


@kb_router.get("")
def list_knowledge(
    projectId: Optional[str] = Query(default=None),
    category: Optional[str] = None,
    search: Optional[str] = Query(default=None, max_length=500),
    activeOnly: bool = True,
    limit: int = Query(default=DEFAULT_LIST_LIMIT, ge=1, le=MAX_LIST_LIMIT),
    offset: int = Query(default=0, ge=0),
):
    pid: Optional[str] = ...
    if projectId == "all":
        pid = ""
    elif projectId is None:
        pid = None
    else:
        pid = projectId
    with connect() as conn:
        try:
            return KnowledgeRepo.list(
                conn,
                project_id=pid,
                category=category,
                active_only=activeOnly,
                search=search,
                limit=limit,
                offset=offset,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@kb_router.post("", status_code=status.HTTP_201_CREATED)
def create_knowledge(body: KnowledgeCreate):
    with connect() as conn:
        try:
            return KnowledgeRepo.create(
                conn,
                title=body.title,
                content=body.content,
                category=body.category,
                project_id=body.projectId,
                tags=body.tags,
                source=body.source,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))


@kb_router.get("/categories")
def list_knowledge_categories():
    return {"categories": list(KNOWLEDGE_CATEGORIES)}


@kb_router.get("/{kid}")
def get_knowledge(kid: str):
    with connect() as conn:
        k = KnowledgeRepo.get(conn, kid)
        if not k:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Knowledge entry not found")
        return k


@kb_router.patch("/{kid}")
def update_knowledge(kid: str, body: KnowledgeUpdate):
    with connect() as conn:
        try:
            k = KnowledgeRepo.update(
                conn,
                kid,
                title=body.title,
                content=body.content,
                category=body.category,
                project_id=body.projectId,  # type: ignore[arg-type]
                tags=body.tags if body.tags is not None else ...,  # type: ignore[arg-type]
                source=body.source if body.source is not None else ...,  # type: ignore[arg-type]
                active=body.active,
            )
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, str(exc))
        if not k:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Knowledge entry not found")
        return k


@kb_router.delete("/{kid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_knowledge(kid: str):
    with connect() as conn:
        if not KnowledgeRepo.remove(conn, kid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Knowledge entry not found")
