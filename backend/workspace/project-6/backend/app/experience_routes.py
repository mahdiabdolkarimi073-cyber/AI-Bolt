"""HTTP routes for coding experiences and decision-log stats.

Endpoints:
  GET    /experiences                 — list/search experiences
  GET    /experiences/{id}            — get a single experience
  POST   /experiences                 — create a new experience
  PUT    /experiences/{id}            — update an experience
  DELETE /experiences/{id}            — delete an experience
  POST   /experiences/{id}/confirm    — mark an experience as confirmed
  POST   /experiences/{id}/fail       — mark an experience as failed
  GET    /experiences/stats/decisions — decision-log summary stats
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field
from typing import Optional

from app.db import connect
from app.experience_repos import ExperienceRepo, DecisionLogRepo

router = APIRouter(prefix="/experiences", tags=["experiences"])

logger = __import__("logging").getLogger("paide.experiences")


# --- Models ---

class ExperienceCreate(BaseModel):
    title: str = Field(min_length=1, max_length=240)
    problemDescription: str = Field(min_length=1, max_length=16000)
    solutionPattern: str = Field(min_length=1, max_length=16000)
    projectType: Optional[str] = Field(default=None, max_length=120)
    framework: Optional[str] = Field(default=None, max_length=120)
    frameworkVersions: Optional[list[str]] = None
    filesInvolved: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    status: str = Field(default="proposed")
    confidence: int = Field(default=0, ge=-5, le=10)
    conversationId: Optional[str] = None
    projectId: Optional[str] = None
    source: str = Field(default="agent")


class ExperienceUpdate(BaseModel):
    title: Optional[str] = Field(default=None, min_length=1, max_length=240)
    problemDescription: Optional[str] = Field(default=None, max_length=16000)
    solutionPattern: Optional[str] = Field(default=None, max_length=16000)
    projectType: Optional[str] = None
    framework: Optional[str] = None
    frameworkVersions: Optional[list[str]] = None
    filesInvolved: Optional[list[str]] = None
    tags: Optional[list[str]] = None
    status: Optional[str] = None
    confidence: Optional[int] = Field(default=None, ge=-5, le=10)
    failureNote: Optional[str] = None


# --- Routes ---

@router.get("")
def list_experiences(
    projectId: Optional[str] = Query(default=None),
    status: Optional[str] = Query(default=None),
    framework: Optional[str] = Query(default=None),
    search: Optional[str] = Query(default=None),
    limit: int = Query(default=50, ge=1, le=200),
    offset: int = Query(default=0, ge=0),
):
    with connect() as conn:
        result = ExperienceRepo.list(
            conn,
            project_id=projectId,
            status=status,
            framework=framework,
            active_only=False,
            search=search,
            limit=limit,
            offset=offset,
        )
        return result


@router.get("/stats/decisions")
def decision_stats():
    with connect() as conn:
        return DecisionLogRepo.stats(conn)


@router.get("/{eid}")
def get_experience(eid: str):
    with connect() as conn:
        exp = ExperienceRepo.get(conn, eid)
        if not exp:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Experience not found."})
        return exp


@router.post("", status_code=status.HTTP_201_CREATED)
def create_experience(body: ExperienceCreate):
    with connect() as conn:
        try:
            exp = ExperienceRepo.create(
                conn,
                title=body.title,
                problem_description=body.problemDescription,
                solution_pattern=body.solutionPattern,
                project_type=body.projectType,
                framework=body.framework,
                framework_versions=body.frameworkVersions,
                files_involved=body.filesInvolved,
                tags=body.tags,
                status=body.status,
                confidence=body.confidence,
                conversation_id=body.conversationId,
                project_id=body.projectId,
                source=body.source,
            )
            return exp
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "validation_error", "message": str(exc)})


@router.put("/{eid}")
def update_experience(eid: str, body: ExperienceUpdate):
    with connect() as conn:
        try:
            exp = ExperienceRepo.update(
                conn,
                eid,
                title=body.title,
                problem_description=body.problemDescription,
                solution_pattern=body.solutionPattern,
                project_type=body.projectType,
                framework=body.framework,
                framework_versions=body.frameworkVersions,
                files_involved=body.filesInvolved,
                tags=body.tags,
                status=body.status,
                confidence=body.confidence,
                failure_note=body.failureNote,
            )
            if not exp:
                raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Experience not found."})
            return exp
        except ValueError as exc:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, detail={"code": "validation_error", "message": str(exc)})


@router.delete("/{eid}", status_code=status.HTTP_204_NO_CONTENT)
def delete_experience(eid: str):
    with connect() as conn:
        if not ExperienceRepo.remove(conn, eid):
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Experience not found."})


@router.post("/{eid}/confirm", status_code=status.HTTP_200_OK)
def confirm_experience(eid: str):
    with connect() as conn:
        exp = ExperienceRepo.update(conn, eid, status="confirmed")
        if not exp:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Experience not found."})
        return exp


@router.post("/{eid}/fail", status_code=status.HTTP_200_OK)
def fail_experience(eid: str, body: Optional[ExperienceUpdate] = None):
    failure_note = body.failureNote if body else None
    with connect() as conn:
        exp = ExperienceRepo.update(conn, eid, status="failed", failure_note=failure_note)
        if not exp:
            raise HTTPException(status.HTTP_404_NOT_FOUND, detail={"code": "not_found", "message": "Experience not found."})
        return exp
