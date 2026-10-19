"""Data-access layer for the backend. One repository per aggregate."""
from __future__ import annotations

import sqlite3
from typing import Optional

from app.db import query_all, query_one, execute
from app.utils import uid, now_ms, dumps, loads


def _row_to_project(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "path": row["path"],
        "template": row["template"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row_to_conversation(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "projectId": row["project_id"],
        "title": row["title"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row_to_message(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "conversationId": row["conversation_id"],
        "role": row["role"],
        "content": row["content"],
        "steps": loads(row["steps"]),
        "createdAt": row["created_at"],
    }


def _row_to_provider(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "enabled": bool(row["enabled"]),
        "model": row["model"],
        "baseUrl": row["base_url"],
        "hasApiKey": bool(row["api_key"]),
    }


class ProjectRepo:
    @staticmethod
    def list(conn: sqlite3.Connection) -> list[dict]:
        rows = query_all(conn, "SELECT * FROM projects ORDER BY updated_at DESC")
        return [_row_to_project(r) for r in rows]

    @staticmethod
    def get(conn: sqlite3.Connection, pid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM projects WHERE id = ?", (pid,))
        return _row_to_project(row) if row else None

    @staticmethod
    def create(conn: sqlite3.Connection, *, name: str, path: str, template: str) -> dict:
        pid = uid("prj")
        ts = now_ms()
        execute(
            conn,
            "INSERT INTO projects (id, name, path, template, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (pid, name, path, template, ts, ts),
        )
        return {"id": pid, "name": name, "path": path, "template": template, "createdAt": ts, "updatedAt": ts}

    @staticmethod
    def update(conn: sqlite3.Connection, pid: str, *, name: Optional[str], path: Optional[str]) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM projects WHERE id = ?", (pid,))
        if not row:
            return None
        new_name = name if name is not None else row["name"]
        new_path = path if path is not None else row["path"]
        ts = now_ms()
        execute(conn, "UPDATE projects SET name=?, path=?, updated_at=? WHERE id=?", (new_name, new_path, ts, pid))
        return _row_to_project(query_one(conn, "SELECT * FROM projects WHERE id = ?", (pid,)))

    @staticmethod
    def remove(conn: sqlite3.Connection, pid: str) -> bool:
        cur = execute(conn, "DELETE FROM projects WHERE id = ?", (pid,))
        return cur.rowcount > 0


class ConversationRepo:
    @staticmethod
    def list(conn: sqlite3.Connection, project_id: Optional[str]) -> list[dict]:
        if project_id is None:
            rows = query_all(conn, "SELECT * FROM conversations ORDER BY updated_at DESC")
        elif project_id == "":
            rows = query_all(conn, "SELECT * FROM conversations WHERE project_id IS NULL ORDER BY updated_at DESC")
        else:
            rows = query_all(conn, "SELECT * FROM conversations WHERE project_id = ? ORDER BY updated_at DESC", (project_id,))
        return [_row_to_conversation(r) for r in rows]

    @staticmethod
    def get(conn: sqlite3.Connection, cid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM conversations WHERE id = ?", (cid,))
        return _row_to_conversation(row) if row else None

    @staticmethod
    def create(conn: sqlite3.Connection, *, project_id: Optional[str], title: str) -> dict:
        cid = uid("cnv")
        ts = now_ms()
        execute(
            conn,
            "INSERT INTO conversations (id, project_id, title, created_at, updated_at) VALUES (?,?,?,?,?)",
            (cid, project_id, title, ts, ts),
        )
        return {"id": cid, "projectId": project_id, "title": title, "createdAt": ts, "updatedAt": ts}

    @staticmethod
    def rename(conn: sqlite3.Connection, cid: str, title: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM conversations WHERE id = ?", (cid,))
        if not row:
            return None
        execute(conn, "UPDATE conversations SET title=?, updated_at=? WHERE id=?", (title, now_ms(), cid))
        return _row_to_conversation(query_one(conn, "SELECT * FROM conversations WHERE id = ?", (cid,)))

    @staticmethod
    def remove(conn: sqlite3.Connection, cid: str) -> bool:
        cur = execute(conn, "DELETE FROM conversations WHERE id = ?", (cid,))
        return cur.rowcount > 0


class MessageRepo:
    @staticmethod
    def list(conn: sqlite3.Connection, conversation_id: str) -> list[dict]:
        rows = query_all(
            conn,
            "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC",
            (conversation_id,),
        )
        return [_row_to_message(r) for r in rows]

    @staticmethod
    def append(
        conn: sqlite3.Connection,
        *,
        conversation_id: str,
        role: str,
        content: str,
        steps: Optional[list] = None,
    ) -> dict:
        mid = uid("msg")
        ts = now_ms()
        execute(
            conn,
            "INSERT INTO messages (id, conversation_id, role, content, steps, created_at) VALUES (?,?,?,?,?,?)",
            (mid, conversation_id, role, content, dumps(steps) if steps else None, ts),
        )
        execute(conn, "UPDATE conversations SET updated_at=? WHERE id=?", (ts, conversation_id))
        return {"id": mid, "conversationId": conversation_id, "role": role, "content": content, "steps": steps, "createdAt": ts}

    @staticmethod
    def remove(conn: sqlite3.Connection, mid: str) -> bool:
        cur = execute(conn, "DELETE FROM messages WHERE id = ?", (mid,))
        return cur.rowcount > 0

    @staticmethod
    def clear(conn: sqlite3.Connection, conversation_id: str) -> None:
        execute(conn, "DELETE FROM messages WHERE conversation_id = ?", (conversation_id,))


class ProviderRepo:
    DEFAULTS = [
        ("gemini", "gemini-2.0-flash"),
        ("groq", "llama-3.3-70b"),
        ("cerebras", "llama-3.1-8b"),
        ("openrouter", "auto"),
    ]

    @staticmethod
    def _seed(conn: sqlite3.Connection) -> None:
        for pid, model in ProviderRepo.DEFAULTS:
            execute(
                conn,
                "INSERT OR IGNORE INTO provider_configs (id, enabled, model, updated_at) VALUES (?,?,?,strftime('%s','now'))",
                (pid, 1 if pid == "gemini" else 0, model),
            )

    @staticmethod
    def list(conn: sqlite3.Connection) -> list[dict]:
        ProviderRepo._seed(conn)
        rows = query_all(conn, "SELECT * FROM provider_configs ORDER BY id")
        return [_row_to_provider(r) for r in rows]

    @staticmethod
    def get(conn: sqlite3.Connection, pid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM provider_configs WHERE id = ?", (pid,))
        return _row_to_provider(row) if row else None

    @staticmethod
    def upsert(
        conn: sqlite3.Connection,
        pid: str,
        *,
        enabled: bool,
        model: str,
        base_url: Optional[str] = None,
    ) -> Optional[dict]:
        ProviderRepo._seed(conn)
        execute(
            conn,
            """
            INSERT INTO provider_configs (id, enabled, model, base_url, updated_at)
            VALUES (?,?,?,?,strftime('%s','now'))
            ON CONFLICT(id) DO UPDATE SET
                enabled = excluded.enabled,
                model = excluded.model,
                base_url = excluded.base_url,
                updated_at = strftime('%s','now')
            """,
            (pid, int(enabled), model, base_url),
        )
        return ProviderRepo.get(conn, pid)

    @staticmethod
    def set_api_key(conn: sqlite3.Connection, pid: str, key: Optional[str]) -> Optional[dict]:
        ProviderRepo._seed(conn)
        execute(conn, "UPDATE provider_configs SET api_key=?, updated_at=strftime('%s','now') WHERE id=?", (key, pid))
        return ProviderRepo.get(conn, pid)


class SettingsRepo:
    @staticmethod
    def get(conn: sqlite3.Connection) -> dict:
        row = query_one(conn, "SELECT * FROM settings WHERE id = 1")
        if not row:
            return {"activeProvider": "gemini", "activeProjectId": None, "theme": "dark", "fontSize": 13, "tabSize": 2}
        return {
            "activeProvider": row["active_provider"],
            "activeProjectId": row["active_project_id"],
            "theme": row["theme"],
            "fontSize": row["font_size"],
            "tabSize": row["tab_size"],
        }

    @staticmethod
    def update(conn: sqlite3.Connection, patch: dict) -> dict:
        allowed = {
            "activeProvider": "active_provider",
            "activeProjectId": "active_project_id",
            "theme": "theme",
            "fontSize": "font_size",
            "tabSize": "tab_size",
        }
        sets: list[str] = []
        vals: list = []
        for k, col in allowed.items():
            if k in patch and patch[k] is not None:
                sets.append(f"{col} = ?")
                vals.append(patch[k])
        if sets:
            sets.append("id = 1")
            execute(conn, f"UPDATE settings SET {', '.join(sets)} WHERE id = 1", vals)
        return SettingsRepo.get(conn)
