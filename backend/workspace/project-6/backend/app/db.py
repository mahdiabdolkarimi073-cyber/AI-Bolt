"""SQLite database connection + migration runner.

Uses the stdlib `sqlite3` module — no external database server required.
Migrations are idempotent and tracked in the `_migrations` table.
"""
from __future__ import annotations

import sqlite3
from typing import Any, Iterable, Optional

from app.config import db_path
from app.migrations import MIGRATIONS


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(db_path()), isolation_level=None, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON;")
    conn.execute("PRAGMA journal_mode = WAL;")
    return conn


def run_migrations(conn: sqlite3.Connection) -> None:
    conn.execute(
        "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT DEFAULT (datetime('now')))"
    )
    applied = {row["name"] for row in conn.execute("SELECT name FROM _migrations")}
    for name, sql in MIGRATIONS:
        if name in applied:
            continue
        conn.executescript(sql)
        conn.execute("INSERT INTO _migrations (name) VALUES (?)", (name,))


def query_all(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> list[sqlite3.Row]:
    return list(conn.execute(sql, tuple(params)))


def query_one(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> Optional[sqlite3.Row]:
    return conn.execute(sql, tuple(params)).fetchone()


def execute(conn: sqlite3.Connection, sql: str, params: Iterable[Any] = ()) -> sqlite3.Cursor:
    return conn.execute(sql, tuple(params))
