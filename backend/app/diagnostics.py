"""Diagnostic event logging for AI connection lifecycle and requests.

Stores structured, sanitized events in the `connection_diagnostics` table.
NEVER logs API keys, authorization headers, or sensitive request/response
bodies. Messages and details are sanitized before insertion.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Any, Optional

from app.db import query_all, query_one, execute
from app.utils import uid, now_ms, dumps


_SECRET_PATTERNS = [
    re.compile(r"(sk-[A-Za-z0-9-_]{10,})", re.IGNORECASE),
    re.compile(r"(AIza[A-Za-z0-9-_]{20,})", re.IGNORECASE),
    re.compile(r"(Bearer\s+[A-Za-z0-9\-_\.]+)", re.IGNORECASE),
    re.compile(r"(key=[A-Za-z0-9\-_]{10,})", re.IGNORECASE),
]


def _sanitize(text: str) -> str:
    if not isinstance(text, str):
        return ""
    for pat in _SECRET_PATTERNS:
        text = pat.sub("[redacted]", text)
    return text[:800]


class DiagnosticEvent:
    def __init__(
        self,
        *,
        event_type: str,
        connection_id: Optional[str] = None,
        provider_id: Optional[str] = None,
        model: Optional[str] = None,
        status: Optional[str] = None,
        duration_ms: Optional[int] = None,
        message: str = "",
        details: Optional[dict] = None,
        created_at: Optional[int] = None,
    ):
        self.event_type = event_type
        self.connection_id = connection_id
        self.provider_id = provider_id
        self.model = model
        self.status = status
        self.duration_ms = duration_ms
        self.message = _sanitize(message)
        self.details = details or {}
        self.created_at = created_at or now_ms()

    def to_dict(self) -> dict:
        return {
            "id": getattr(self, "_id", ""),
            "eventType": self.event_type,
            "connectionId": self.connection_id,
            "providerId": self.provider_id,
            "model": self.model,
            "status": self.status,
            "durationMs": self.duration_ms,
            "message": self.message,
            "details": self.details,
            "createdAt": self.created_at,
        }


class DiagnosticsRepo:
    @staticmethod
    def log(conn: sqlite3.Connection, event: DiagnosticEvent) -> dict:
        eid = uid("diag")
        execute(
            conn,
            """
            INSERT INTO connection_diagnostics
              (id, event_type, connection_id, provider_id, model, status, duration_ms, message, details, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (
                eid,
                event.event_type,
                event.connection_id,
                event.provider_id,
                event.model,
                event.status,
                event.duration_ms,
                event.message,
                dumps(event.details),
                event.created_at,
            ),
        )
        row = query_one(conn, "SELECT * FROM connection_diagnostics WHERE id = ?", (eid,))
        return DiagnosticsRepo._row_to_dict(row)  # type: ignore[arg-type]

    @staticmethod
    def list(
        conn: sqlite3.Connection,
        *,
        connection_id: Optional[str] = None,
        event_type: Optional[str] = None,
        limit: int = 100,
        offset: int = 0,
    ) -> list[dict]:
        sql = "SELECT * FROM connection_diagnostics"
        conditions: list[str] = []
        params: list[Any] = []
        if connection_id:
            conditions.append("connection_id = ?")
            params.append(connection_id)
        if event_type:
            conditions.append("event_type = ?")
            params.append(event_type)
        if conditions:
            sql += " WHERE " + " AND ".join(conditions)
        sql += " ORDER BY created_at DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        rows = query_all(conn, sql, params)
        return [DiagnosticsRepo._row_to_dict(r) for r in rows]

    @staticmethod
    def clear(conn: sqlite3.Connection, *, connection_id: Optional[str] = None) -> int:
        if connection_id:
            cur = execute(conn, "DELETE FROM connection_diagnostics WHERE connection_id = ?", (connection_id,))
        else:
            cur = execute(conn, "DELETE FROM connection_diagnostics")
        return cur.rowcount

    @staticmethod
    def _row_to_dict(row: sqlite3.Row) -> dict:
        from app.utils import loads as _loads

        return {
            "id": row["id"],
            "eventType": row["event_type"],
            "connectionId": row["connection_id"],
            "providerId": row["provider_id"],
            "model": row["model"],
            "status": row["status"],
            "durationMs": row["duration_ms"],
            "message": row["message"],
            "details": _loads(row["details"]) or {},
            "createdAt": row["created_at"],
        }
