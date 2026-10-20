"""Diagnostic event routes for AI connection lifecycle and requests.

Provides list, clear, and auto-logs events from connection tests, refresh-models,
and agent runs. Never exposes API keys or secrets.
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query, status

from app.db import connect
from app.diagnostics import DiagnosticsRepo, DiagnosticEvent


router = APIRouter(prefix="/diagnostics", tags=["diagnostics"])


@router.get("")
def list_diagnostics(
    connectionId: Optional[str] = Query(default=None),
    eventType: Optional[str] = Query(default=None),
    limit: int = Query(default=100, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
):
    with connect() as conn:
        return DiagnosticsRepo.list(
            conn,
            connection_id=connectionId,
            event_type=eventType,
            limit=limit,
            offset=offset,
        )


@router.delete("", status_code=status.HTTP_204_NO_CONTENT)
def clear_diagnostics(connectionId: Optional[str] = Query(default=None)):
    with connect() as conn:
        DiagnosticsRepo.clear(conn, connection_id=connectionId)
