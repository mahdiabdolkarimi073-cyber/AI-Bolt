"""API routes for model profiles (fallback chains).

CRUD for profiles and their candidates, per-project profile assignment,
and default profile selection. All responses exclude secrets — candidates
reference connections by id, and credentials are resolved at request time.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.db import connect
from app.profile_repos import (
    ProfileRepo,
    ProfileCandidateRepo,
    ProjectProfileAssignmentRepo,
    DefaultProfileRepo,
    resolve_candidates,
)
from app.connection_repos import ConnectionRepo

router = APIRouter(prefix="/profiles", tags=["model-profiles"])


# --- Profile CRUD ---

class ProfileCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)


class ProfileUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=120)
    description: Optional[str] = Field(default=None, max_length=500)
    enabled: Optional[bool] = None


@router.get("")
def list_profiles():
    with connect() as conn:
        return ProfileRepo.list(conn)


@router.post("", status_code=status.HTTP_201_CREATED)
def create_profile(body: ProfileCreate):
    with connect() as conn:
        return ProfileRepo.create(conn, name=body.name, description=body.description)


# --- Default profile (must be defined BEFORE /{pid} to avoid path shadowing) ---

class DefaultProfileBody(BaseModel):
    profileId: Optional[str] = None


@router.get("/default")
def get_default_profile():
    with connect() as conn:
        pid = DefaultProfileRepo.get(conn)
        if not pid:
            return {"profileId": None}
        p = ProfileRepo.get(conn, pid)
        if not p:
            return {"profileId": None}
        return {"profileId": pid, "profile": p}


@router.put("/default")
def set_default_profile(body: DefaultProfileBody):
    with connect() as conn:
        if body.profileId:
            if not ProfileRepo.get(conn, body.profileId):
                raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        pid = DefaultProfileRepo.set(conn, body.profileId)
        return {"profileId": pid}


# --- Project assignment (must be defined BEFORE /{pid} to avoid path shadowing) ---

class ProjectAssignmentBody(BaseModel):
    profileId: str = Field(min_length=1, max_length=120)


@router.get("/project/{project_id}")
def get_project_assignment(project_id: str):
    with connect() as conn:
        return ProjectProfileAssignmentRepo.get(conn, project_id)


@router.put("/project/{project_id}")
def set_project_assignment(project_id: str, body: ProjectAssignmentBody):
    with connect() as conn:
        if not ProfileRepo.get(conn, body.profileId):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        return ProjectProfileAssignmentRepo.set(conn, project_id, body.profileId)


@router.delete("/project/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
def clear_project_assignment(project_id: str):
    with connect() as conn:
        ProjectProfileAssignmentRepo.clear(conn, project_id)


# --- Profile by id (dynamic path — must come AFTER all static sub-paths) ---

@router.get("/{pid}")
def get_profile(pid: str):
    with connect() as conn:
        item = ProfileRepo.get(conn, pid)
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        return item


@router.patch("/{pid}")
def update_profile(pid: str, body: ProfileUpdate):
    with connect() as conn:
        item = ProfileRepo.update(
            conn, pid,
            name=body.name,
            description=body.description,
            enabled=body.enabled,
        )
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        return item


@router.delete("/{pid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_profile(pid: str):
    with connect() as conn:
        if not ProfileRepo.remove(conn, pid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")


# --- Candidates ---

class CandidateAdd(BaseModel):
    connectionId: str = Field(min_length=1, max_length=120)
    modelId: str = Field(min_length=1, max_length=120)
    priority: int = Field(default=1, ge=1, le=100)
    label: Optional[str] = Field(default=None, max_length=120)


class CandidateUpdate(BaseModel):
    priority: Optional[int] = Field(default=None, ge=1, le=100)
    enabled: Optional[bool] = None
    label: Optional[str] = None


class ReorderBody(BaseModel):
    orderedIds: list[str] = Field(min_length=0, max_length=50)


@router.post("/{pid}/candidates", status_code=status.HTTP_201_CREATED)
def add_candidate(pid: str, body: CandidateAdd):
    with connect() as conn:
        if not ProfileRepo.get(conn, pid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        if not ConnectionRepo.get(conn, body.connectionId):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Connection not found")
        return ProfileCandidateRepo.add(
            conn,
            profile_id=pid,
            connection_id=body.connectionId,
            model_id=body.modelId,
            priority=body.priority,
            label=body.label,
        )


@router.patch("/{pid}/candidates/{cid}")
def update_candidate(pid: str, cid: str, body: CandidateUpdate):
    with connect() as conn:
        item = ProfileCandidateRepo.update(
            conn, cid,
            priority=body.priority,
            enabled=body.enabled,
            label=body.label,
        )
        if not item:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Candidate not found")
        return item


@router.delete("/{pid}/candidates/{cid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_candidate(pid: str, cid: str):
    with connect() as conn:
        if not ProfileCandidateRepo.remove(conn, cid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Candidate not found")


@router.put("/{pid}/candidates/reorder")
def reorder_candidates(pid: str, body: ReorderBody):
    with connect() as conn:
        if not ProfileRepo.get(conn, pid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        ProfileCandidateRepo.reorder(conn, pid, body.orderedIds)
        return ProfileCandidateRepo.list(conn, pid)


# --- Resolve candidates (for the failover engine) ---

@router.get("/{pid}/candidates/resolve")
def get_resolved_candidates(pid: str):
    """Return the ordered, enabled, usable candidates for a profile."""
    with connect() as conn:
        if not ProfileRepo.get(conn, pid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, "Profile not found")
        return resolve_candidates(conn, pid)