"""FastAPI route definitions. Registered by app.main."""
from __future__ import annotations

import sqlite3
from typing import Optional

from fastapi import APIRouter, HTTPException, status, Request
from pydantic import BaseModel, Field

from app.db import connect
from app.repositories import ProjectRepo, ConversationRepo, MessageRepo, ProviderRepo, SettingsRepo


# --- Projects ---
router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    path: str = Field(min_length=1, max_length=512)
    template: str = Field(default="blank", max_length=60)
    workspacePath: Optional[str] = Field(default=None, max_length=120)
    importSource: str = Field(default="manual", max_length=60)


class ProjectUpdate(BaseModel):
    name: Optional[str] = Field(default=None, max_length=120)
    path: Optional[str] = Field(default=None, max_length=512)
    workspacePath: Optional[str] = Field(default=None, max_length=120)


@router.get("")
def list_projects():
    with connect() as conn:
        return ProjectRepo.list(conn)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_project(body: ProjectCreate):
    with connect() as conn:
        return ProjectRepo.create(
            conn,
            name=body.name,
            path=body.path,
            template=body.template,
            workspace_path=body.workspacePath,
            import_source=body.importSource,
        )


@router.get("/{pid}")
def get_project(pid: str):
    with connect() as conn:
        p = ProjectRepo.get(conn, pid)
        if not p:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        return p


@router.patch("/{pid}")
def update_project(pid: str, body: ProjectUpdate):
    with connect() as conn:
        p = ProjectRepo.update(conn, pid, name=body.name, path=body.path, workspace_path=body.workspacePath)
        if not p:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")
        return p


@router.delete("/{pid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_project(pid: str):
    with connect() as conn:
        if not ProjectRepo.remove(conn, pid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Project not found")


# --- Conversations ---
conv_router = APIRouter(prefix="/conversations", tags=["conversations"])


class ConversationCreate(BaseModel):
    projectId: Optional[str] = None
    title: str = Field(min_length=1, max_length=200)


class ConversationRename(BaseModel):
    title: str = Field(min_length=1, max_length=200)


class MessageAppend(BaseModel):
    role: str = Field(pattern="^(user|assistant|system)$")
    content: str = Field(min_length=1)
    steps: Optional[list] = None


@conv_router.get("")
def list_conversations(projectId: Optional[str] = None):
    with connect() as conn:
        return ConversationRepo.list(conn, projectId)


@conv_router.post("", status_code=status.HTTP_201_CREATED)
def create_conversation(body: ConversationCreate):
    with connect() as conn:
        return ConversationRepo.create(conn, project_id=body.projectId, title=body.title)


@conv_router.get("/{cid}")
def get_conversation(cid: str):
    with connect() as conn:
        c = ConversationRepo.get(conn, cid)
        if not c:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
        return c


@conv_router.patch("/{cid}")
def rename_conversation(cid: str, body: ConversationRename):
    with connect() as conn:
        c = ConversationRepo.rename(conn, cid, body.title)
        if not c:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
        return c


@conv_router.delete("/{cid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_conversation(cid: str):
    with connect() as conn:
        if not ConversationRepo.remove(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")


@conv_router.get("/{cid}/messages")
def list_messages(cid: str):
    with connect() as conn:
        if not ConversationRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
        return MessageRepo.list(conn, cid)


@conv_router.post("/{cid}/messages", status_code=status.HTTP_201_CREATED)
def append_message(cid: str, body: MessageAppend):
    with connect() as conn:
        if not ConversationRepo.get(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Conversation not found")
        return MessageRepo.append(
            conn,
            conversation_id=cid,
            role=body.role,
            content=body.content,
            steps=body.steps,
        )


@conv_router.delete("/{cid}/messages", status_code=status.HTTP_204_NO_CONTENT)
def clear_messages(cid: str):
    with connect() as conn:
        MessageRepo.clear(conn, cid)


# --- Messages (top-level for direct delete) ---
msg_router = APIRouter(prefix="/messages", tags=["messages"])


@msg_router.delete("/{mid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_message(mid: str):
    with connect() as conn:
        if not MessageRepo.remove(conn, mid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Message not found")


# --- Providers ---
prov_router = APIRouter(prefix="/providers", tags=["providers"])


class ProviderUpsert(BaseModel):
    enabled: bool
    model: str = Field(min_length=1, max_length=120)
    baseUrl: Optional[str] = Field(default=None, max_length=512)


class ProviderKey(BaseModel):
    key: Optional[str] = None


@prov_router.get("")
def list_providers():
    with connect() as conn:
        return ProviderRepo.list(conn)


@prov_router.put("/{pid}")
def upsert_provider(pid: str, body: ProviderUpsert):
    with connect() as conn:
        p = ProviderRepo.upsert(conn, pid, enabled=body.enabled, model=body.model, base_url=body.baseUrl)
        if not p:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown provider")
        return p


@prov_router.post("/{pid}/api-key")
def set_provider_key(pid: str, body: ProviderKey):
    with connect() as conn:
        p = ProviderRepo.set_api_key(conn, pid, body.key)
        if not p:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Unknown provider")
        return p


# --- Settings ---
settings_router = APIRouter(prefix="/settings", tags=["settings"])


class SettingsPatch(BaseModel):
    activeProvider: Optional[str] = None
    activeProjectId: Optional[str] = None
    theme: Optional[str] = None
    fontSize: Optional[int] = None
    tabSize: Optional[int] = None


@settings_router.get("")
def get_settings():
    with connect() as conn:
        return SettingsRepo.get(conn)


@settings_router.patch("")
def patch_settings(body: SettingsPatch):
    with connect() as conn:
        return SettingsRepo.update(conn, body.model_dump(exclude_none=True))


def register_routes(app):
    app.include_router(router)
    app.include_router(conv_router)
    app.include_router(msg_router)
    app.include_router(prov_router)
    app.include_router(settings_router)
