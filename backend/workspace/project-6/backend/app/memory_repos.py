"""Data-access layer for persistent memory and project knowledge base.

Two aggregates live here:

  - MemoryRepo  -> `memories` table. Personal/general durable facts, prefs,
    conventions, decisions, constraints, instructions, tasks. Optionally
    scoped to a project_id.
  - KnowledgeRepo -> `knowledge_entries` table. Project-scoped durable
    documentation (summaries, architecture, conventions, limitations).

Both tables are backed by FTS5 virtual tables (see migration 0003) for
full-text search. Rows are the source of truth; FTS indexes are synced via
triggers. Search falls back to LIKE when FTS5 is unavailable (older SQLite
builds), so the app degrades safely.

Security: these tables never store secrets. `looks_like_secret()` rejects
content that matches common credential patterns before persisting. This is a
defense-in-depth safeguard — it is NOT a substitute for user judgment.
"""
from __future__ import annotations

import re
import sqlite3
from typing import Optional

from app.db import query_all, query_one, execute
from app.utils import uid, now_ms, dumps, loads


# --- Valid enum values (mirror the CHECK constraints in the schema) ---

MEMORY_TYPES = (
    "preference", "convention", "decision", "constraint",
    "instruction", "task", "fact", "note",
)
KNOWLEDGE_CATEGORIES = (
    "summary", "architecture", "convention", "limitation",
    "documentation", "note", "other",
)

DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200
MAX_CONTENT_CHARS = 16_000
MAX_TITLE_CHARS = 240
MAX_TAGS_COUNT = 20
MAX_TAG_CHARS = 60
MAX_SOURCE_CHARS = 240


# --- Secret detection (defense in depth) ---
# Matches common credential patterns. We refuse to persist anything that
# looks like an API key / token / connection string as a memory or knowledge
# entry. This is intentionally conservative: false positives are acceptable,
# false negatives are not.

_SECRET_PATTERNS = [
    re.compile(r"sk-[A-Za-z0-9_-]{16,}"),            # OpenAI-style
    re.compile(r"AIza[A-Za-z0-9_-]{20,}"),          # Google API keys
    re.compile(r"gh[pousr]_[A-Za-z0-9]{20,}"),      # GitHub tokens
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),    # Slack tokens
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),  # PEM private keys
    re.compile(r"(?i)password\s*[:=]\s*\S{4,}"),    # password = ...
    re.compile(r"(?i)(api[_-]?key|secret|token)\s*[:=]\s*[A-Za-z0-9_\-]{12,}"),
    re.compile(r"postgresql?://[^:\s]+:[^@\s]+@"),  # DB connection strings
    re.compile(r"mongodb(\+srv)?://[^:\s]+:[^@\s]+@"),
    re.compile(r"redis://:[^@\s]+@"),
]


def looks_like_secret(text: str) -> bool:
    """True when `text` matches a known credential pattern. Used to refuse
    persisting obvious secrets as memory/knowledge content."""
    if not isinstance(text, str) or not text:
        return False
    # Only scan the first 8KB to keep it cheap.
    sample = text[:8192]
    for pat in _SECRET_PATTERNS:
        if pat.search(sample):
            return True
    return False


# --- Row mappers ---

def _row_to_memory(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "type": row["type"],
        "title": row["title"],
        "content": row["content"],
        "projectId": row["project_id"],
        "tags": loads(row["tags"]) or [],
        "importance": row["importance"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "lastAccessedAt": row["last_accessed_at"],
    }


def _row_to_knowledge(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "content": row["content"],
        "category": row["category"],
        "projectId": row["project_id"],
        "tags": loads(row["tags"]) or [],
        "source": row["source"],
        "active": bool(row["active"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


# --- Tag normalization ---

def normalize_tags(tags: Optional[list]) -> list[str]:
    if not tags:
        return []
    if not isinstance(tags, list):
        raise ValueError("tags must be a list of strings.")
    out: list[str] = []
    seen: set[str] = set()
    for t in tags:
        if not isinstance(t, str):
            raise ValueError("tags must be strings.")
        cleaned = t.strip().lower()
        if not cleaned:
            continue
        if len(cleaned) > MAX_TAG_CHARS:
            raise ValueError(f"tag too long (max {MAX_TAG_CHARS} chars).")
        if cleaned not in seen:
            seen.add(cleaned)
            out.append(cleaned)
    if len(out) > MAX_TAGS_COUNT:
        raise ValueError(f"too many tags (max {MAX_TAGS_COUNT}).")
    return out


# --- FTS5 availability check ---

def _fts_available(conn: sqlite3.Connection) -> bool:
    """True when the FTS5 extension is compiled in."""
    try:
        conn.execute("SELECT 1 FROM sqlite_master WHERE name='memories_fts' LIMIT 1").fetchone()
        # Probe a trivial FTS query to confirm the extension is usable.
        conn.execute("SELECT count(*) FROM memories_fts WHERE memories_fts MATCH 'a'").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


# --- MemoryRepo ---

class MemoryRepo:
    @staticmethod
    def list(
        conn: sqlite3.Connection,
        *,
        project_id: Optional[str] = ...,
        type_filter: Optional[str] = None,
        active_only: bool = True,
        search: Optional[str] = None,
        limit: int = DEFAULT_LIST_LIMIT,
        offset: int = 0,
    ) -> dict:
        """List/search memories. Returns {'items': [...], 'total': int}.

        project_id filtering:
          - None  -> only memories with project_id IS NULL (personal/general)
          - ""    -> all memories regardless of project
          - "<id>" -> memories scoped to that project OR project_id IS NULL
                      (global memories apply everywhere)
        """
        limit = max(1, min(limit, MAX_LIST_LIMIT))
        offset = max(0, offset)
        where: list[str] = []
        params: list = []

        if active_only:
            where.append("active = 1")
        if type_filter:
            if type_filter not in MEMORY_TYPES:
                raise ValueError(f"unknown memory type: {type_filter}")
            where.append("type = ?")
            params.append(type_filter)

        if project_id is not ... and project_id != "":
            if project_id is None:
                where.append("project_id IS NULL")
            else:
                # Project-scoped OR global (project_id IS NULL).
                where.append("(project_id = ? OR project_id IS NULL)")
                params.append(project_id)

        # Search path: FTS5 when available, else LIKE fallback.
        if search and search.strip():
            q = search.strip()
            if _fts_available(conn):
                # Rank by FTS bm25 score (lower = better; we negate for DESC).
                where_sql = (" AND " + " AND ".join(where)) if where else ""
                # Escape double quotes in the query to form a valid MATCH phrase.
                phrase = '"' + q.replace('"', '""') + '"'
                try:
                    rows = query_all(
                        conn,
                        f"""
                        SELECT m.*, rank FROM memories_fts f
                        JOIN memories m ON m.rowid = f.rowid
                        WHERE memories_fts MATCH ?{where_sql}
                        ORDER BY rank ASC
                        LIMIT ? OFFSET ?
                        """,
                        [phrase, *params, limit, offset],
                    )
                    count_row = query_one(
                        conn,
                        f"""
                        SELECT count(*) AS c FROM memories_fts f
                        JOIN memories m ON m.rowid = f.rowid
                        WHERE memories_fts MATCH ?{where_sql}
                        """,
                        [phrase, *params],
                    )
                    return {"items": [_row_to_memory(r) for r in rows], "total": int(count_row["c"]) if count_row else 0}
                except sqlite3.OperationalError:
                    pass  # fall through to LIKE
            # LIKE fallback.
            where.append("(title LIKE ? OR content LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like])

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = query_all(
            conn,
            f"SELECT * FROM memories{where_sql} ORDER BY importance DESC, updated_at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        )
        count_row = query_one(conn, f"SELECT count(*) AS c FROM memories{where_sql}", params)
        return {"items": [_row_to_memory(r) for r in rows], "total": int(count_row["c"]) if count_row else 0}

    @staticmethod
    def get(conn: sqlite3.Connection, mid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM memories WHERE id = ?", (mid,))
        if not row:
            return None
        # Touch last-accessed.
        execute(conn, "UPDATE memories SET last_accessed_at = ? WHERE id = ?", (now_ms(), mid))
        return _row_to_memory(row)

    @staticmethod
    def create(
        conn: sqlite3.Connection,
        *,
        type: str,
        title: str,
        content: str,
        project_id: Optional[str] = None,
        tags: Optional[list] = None,
        importance: int = 0,
    ) -> dict:
        if type not in MEMORY_TYPES:
            raise ValueError(f"unknown memory type: {type}")
        _validate_title(title)
        _validate_content(content)
        if looks_like_secret(content) or looks_like_secret(title):
            raise ValueError("Refusing to store content that looks like a secret/credential.")
        tag_list = normalize_tags(tags)
        importance = _clamp(importance, -5, 10)
        mid = uid("mem")
        ts = now_ms()
        execute(
            conn,
            """
            INSERT INTO memories
              (id, type, title, content, project_id, tags, importance, active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (mid, type, title, content, project_id, dumps(tag_list), importance, 1, ts, ts),
        )
        return MemoryRepo.get(conn, mid)  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        mid: str,
        *,
        type: Optional[str] = None,
        title: Optional[str] = None,
        content: Optional[str] = None,
        project_id: ... = ...,  # type: ignore[valid-type]
        tags: Optional[list] = ...,
        importance: Optional[int] = None,
        active: Optional[bool] = None,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM memories WHERE id = ?", (mid,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if type is not None:
            if type not in MEMORY_TYPES:
                raise ValueError(f"unknown memory type: {type}")
            sets.append("type = ?")
            vals.append(type)
        if title is not None:
            _validate_title(title)
            sets.append("title = ?")
            vals.append(title)
        if content is not None:
            _validate_content(content)
            if looks_like_secret(content):
                raise ValueError("Refusing to store content that looks like a secret/credential.")
            sets.append("content = ?")
            vals.append(content)
        if project_id is not ...:
            sets.append("project_id = ?")
            vals.append(project_id)
        if tags is not ...:
            tag_list = normalize_tags(tags)
            sets.append("tags = ?")
            vals.append(dumps(tag_list))
        if importance is not None:
            importance = _clamp(importance, -5, 10)
            sets.append("importance = ?")
            vals.append(importance)
        if active is not None:
            sets.append("active = ?")
            vals.append(int(active))
        if not sets:
            return _row_to_memory(row)
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(mid)
        execute(conn, f"UPDATE memories SET {', '.join(sets)} WHERE id = ?", vals)
        return MemoryRepo.get(conn, mid)

    @staticmethod
    def remove(conn: sqlite3.Connection, mid: str) -> bool:
        cur = execute(conn, "DELETE FROM memories WHERE id = ?", (mid,))
        return cur.rowcount > 0


# --- KnowledgeRepo ---

class KnowledgeRepo:
    @staticmethod
    def list(
        conn: sqlite3.Connection,
        *,
        project_id: Optional[str] = ...,
        category: Optional[str] = None,
        active_only: bool = True,
        search: Optional[str] = None,
        limit: int = DEFAULT_LIST_LIMIT,
        offset: int = 0,
    ) -> dict:
        limit = max(1, min(limit, MAX_LIST_LIMIT))
        offset = max(0, offset)
        where: list[str] = []
        params: list = []
        if active_only:
            where.append("active = 1")
        if category:
            if category not in KNOWLEDGE_CATEGORIES:
                raise ValueError(f"unknown category: {category}")
            where.append("category = ?")
            params.append(category)
        if project_id is not ... and project_id != "":
            if project_id is None:
                where.append("project_id IS NULL")
            else:
                where.append("(project_id = ? OR project_id IS NULL)")
                params.append(project_id)

        if search and search.strip():
            q = search.strip()
            if _fts_available(conn):
                where_sql = (" AND " + " AND ".join(where)) if where else ""
                phrase = '"' + q.replace('"', '""') + '"'
                try:
                    rows = query_all(
                        conn,
                        f"""
                        SELECT k.*, rank FROM knowledge_fts f
                        JOIN knowledge_entries k ON k.rowid = f.rowid
                        WHERE knowledge_fts MATCH ?{where_sql}
                        ORDER BY rank ASC
                        LIMIT ? OFFSET ?
                        """,
                        [phrase, *params, limit, offset],
                    )
                    count_row = query_one(
                        conn,
                        f"""
                        SELECT count(*) AS c FROM knowledge_fts f
                        JOIN knowledge_entries k ON k.rowid = f.rowid
                        WHERE knowledge_fts MATCH ?{where_sql}
                        """,
                        [phrase, *params],
                    )
                    return {"items": [_row_to_knowledge(r) for r in rows], "total": int(count_row["c"]) if count_row else 0}
                except sqlite3.OperationalError:
                    pass
            where.append("(title LIKE ? OR content LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like])

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = query_all(
            conn,
            f"SELECT * FROM knowledge_entries{where_sql} ORDER BY updated_at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        )
        count_row = query_one(conn, f"SELECT count(*) AS c FROM knowledge_entries{where_sql}", params)
        return {"items": [_row_to_knowledge(r) for r in rows], "total": int(count_row["c"]) if count_row else 0}

    @staticmethod
    def get(conn: sqlite3.Connection, kid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM knowledge_entries WHERE id = ?", (kid,))
        return _row_to_knowledge(row) if row else None

    @staticmethod
    def create(
        conn: sqlite3.Connection,
        *,
        title: str,
        content: str,
        category: str,
        project_id: Optional[str] = None,
        tags: Optional[list] = None,
        source: Optional[str] = None,
    ) -> dict:
        if category not in KNOWLEDGE_CATEGORIES:
            raise ValueError(f"unknown category: {category}")
        _validate_title(title)
        _validate_content(content)
        if looks_like_secret(content) or looks_like_secret(title):
            raise ValueError("Refusing to store content that looks like a secret/credential.")
        tag_list = normalize_tags(tags)
        if source is not None:
            source = source.strip()[:MAX_SOURCE_CHARS] or None
        kid = uid("kb")
        ts = now_ms()
        execute(
            conn,
            """
            INSERT INTO knowledge_entries
              (id, title, content, category, project_id, tags, source, active, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (kid, title, content, category, project_id, dumps(tag_list), source, 1, ts, ts),
        )
        return KnowledgeRepo.get(conn, kid)  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        kid: str,
        *,
        title: Optional[str] = None,
        content: Optional[str] = None,
        category: Optional[str] = None,
        project_id: ... = ...,
        tags: Optional[list] = ...,
        source: ... = ...,
        active: Optional[bool] = None,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM knowledge_entries WHERE id = ?", (kid,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if title is not None:
            _validate_title(title)
            sets.append("title = ?")
            vals.append(title)
        if content is not None:
            _validate_content(content)
            if looks_like_secret(content):
                raise ValueError("Refusing to store content that looks like a secret/credential.")
            sets.append("content = ?")
            vals.append(content)
        if category is not None:
            if category not in KNOWLEDGE_CATEGORIES:
                raise ValueError(f"unknown category: {category}")
            sets.append("category = ?")
            vals.append(category)
        if project_id is not ...:
            sets.append("project_id = ?")
            vals.append(project_id)
        if tags is not ...:
            tag_list = normalize_tags(tags)
            sets.append("tags = ?")
            vals.append(dumps(tag_list))
        if source is not ...:
            src = source.strip()[:MAX_SOURCE_CHARS] if source else None
            sets.append("source = ?")
            vals.append(src)
        if active is not None:
            sets.append("active = ?")
            vals.append(int(active))
        if not sets:
            return _row_to_knowledge(row)
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(kid)
        execute(conn, f"UPDATE knowledge_entries SET {', '.join(sets)} WHERE id = ?", vals)
        return KnowledgeRepo.get(conn, kid)

    @staticmethod
    def remove(conn: sqlite3.Connection, kid: str) -> bool:
        cur = execute(conn, "DELETE FROM knowledge_entries WHERE id = ?", (kid,))
        return cur.rowcount > 0


# --- Validation helpers ---

def _validate_title(title: str) -> None:
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title is required.")
    if len(title) > MAX_TITLE_CHARS:
        raise ValueError(f"title too long (max {MAX_TITLE_CHARS} chars).")


def _validate_content(content: str) -> None:
    if not isinstance(content, str) or not content.strip():
        raise ValueError("content is required.")
    if len(content) > MAX_CONTENT_CHARS:
        raise ValueError(f"content too long (max {MAX_CONTENT_CHARS} chars).")


def _clamp(value: int, lo: int, hi: int) -> int:
    try:
        v = int(value)
    except (TypeError, ValueError):
        v = 0
    return max(lo, min(hi, v))
