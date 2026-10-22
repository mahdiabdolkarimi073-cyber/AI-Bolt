"""Data-access layer for coding experiences and agent decision logs.

Coding experiences are structured, outcome-tracked records of reusable
solutions. They are distinct from memories (general facts) and knowledge
(project documentation): experiences capture problem→solution patterns
that can reduce Gemini calls for repetitive tasks.

Security: the same secret-detection logic from memory_repos is reused to
refuse persisting credentials, API keys, or sensitive content.
"""
from __future__ import annotations

import json
import sqlite3
from typing import Optional

from app.db import query_all, query_one, execute
from app.utils import uid, now_ms, dumps, loads
from app.memory_repos import looks_like_secret


EXPERIENCE_STATUSES = ("proposed", "confirmed", "failed", "superseded")
DECISION_TYPES = ("local_experience", "gemini", "simulation")

DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200
MAX_TITLE_CHARS = 240
MAX_CONTENT_CHARS = 16_000
MAX_TAGS_COUNT = 20
MAX_TAG_CHARS = 60
MAX_FILES_COUNT = 30
MAX_FRAMEWORK_VERSIONS_COUNT = 10


# --- Row mappers ---

def _row_to_experience(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "problemDescription": row["problem_description"],
        "solutionPattern": row["solution_pattern"],
        "projectType": row["project_type"],
        "framework": row["framework"],
        "frameworkVersions": loads(row["framework_versions"]) or [],
        "filesInvolved": loads(row["files_involved"]) or [],
        "tags": loads(row["tags"]) or [],
        "status": row["status"],
        "confidence": row["confidence"],
        "timesReused": row["times_reused"],
        "conversationId": row["conversation_id"],
        "projectId": row["project_id"],
        "source": row["source"],
        "failureNote": row["failure_note"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "confirmedAt": row["confirmed_at"],
    }


def _row_to_decision(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "requestId": row["request_id"],
        "conversationId": row["conversation_id"],
        "decision": row["decision"],
        "reason": row["reason"],
        "experienceId": row["experience_id"],
        "projectId": row["project_id"],
        "framework": row["framework"],
        "confidence": row["confidence"],
        "success": bool(row["success"]) if row["success"] is not None else None,
        "durationMs": row["duration_ms"],
        "createdAt": row["created_at"],
    }


# --- Tag / list normalization (reuse memory_repos helpers) ---

def _normalize_tags(tags: Optional[list]) -> list[str]:
    if not tags:
        return []
    out: list[str] = []
    seen: set[str] = set()
    for t in tags:
        if not isinstance(t, str):
            continue
        cleaned = t.strip().lower()
        if not cleaned or cleaned in seen or len(cleaned) > MAX_TAG_CHARS:
            continue
        seen.add(cleaned)
        out.append(cleaned)
        if len(out) >= MAX_TAGS_COUNT:
            break
    return out


def _normalize_string_list(items: Optional[list], max_count: int) -> list[str]:
    if not items:
        return []
    out: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        cleaned = item.strip()
        if not cleaned:
            continue
        out.append(cleaned)
        if len(out) >= max_count:
            break
    return out


# --- FTS5 check ---

def _fts_available(conn: sqlite3.Connection) -> bool:
    try:
        conn.execute("SELECT 1 FROM sqlite_master WHERE name='experiences_fts' LIMIT 1").fetchone()
        conn.execute("SELECT count(*) FROM experiences_fts WHERE experiences_fts MATCH 'a'").fetchone()
        return True
    except sqlite3.OperationalError:
        return False


# --- ExperienceRepo ---

class ExperienceRepo:
    @staticmethod
    def list(
        conn: sqlite3.Connection,
        *,
        project_id: Optional[str] = ...,
        status: Optional[str] = None,
        framework: Optional[str] = None,
        active_only: bool = True,
        search: Optional[str] = None,
        limit: int = DEFAULT_LIST_LIMIT,
        offset: int = 0,
    ) -> dict:
        """List/search experiences. Returns {'items': [...], 'total': int}."""
        limit = max(1, min(limit, MAX_LIST_LIMIT))
        offset = max(0, offset)
        where: list[str] = []
        params: list = []

        if active_only:
            where.append("status IN ('proposed','confirmed')")
        if status:
            if status not in EXPERIENCE_STATUSES:
                raise ValueError(f"unknown status: {status}")
            where = [s for s in where if "status" not in s]
            where.append("status = ?")
            params.append(status)
        if framework:
            where.append("framework = ?")
            params.append(framework)
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
                        SELECT e.* FROM experiences_fts f
                        JOIN coding_experiences e ON e.rowid = f.rowid
                        WHERE experiences_fts MATCH ?{where_sql}
                        ORDER BY rank ASC
                        LIMIT ? OFFSET ?
                        """,
                        [phrase, *params, limit, offset],
                    )
                    count_row = query_one(
                        conn,
                        f"""
                        SELECT count(*) AS c FROM experiences_fts f
                        JOIN coding_experiences e ON e.rowid = f.rowid
                        WHERE experiences_fts MATCH ?{where_sql}
                        """,
                        [phrase, *params],
                    )
                    return {"items": [_row_to_experience(r) for r in rows], "total": int(count_row["c"]) if count_row else 0}
                except sqlite3.OperationalError:
                    pass
            where.append("(title LIKE ? OR problem_description LIKE ? OR solution_pattern LIKE ?)")
            like = f"%{q}%"
            params.extend([like, like, like])

        where_sql = (" WHERE " + " AND ".join(where)) if where else ""
        rows = query_all(
            conn,
            f"SELECT * FROM coding_experiences{where_sql} ORDER BY confidence DESC, updated_at DESC LIMIT ? OFFSET ?",
            [*params, limit, offset],
        )
        count_row = query_one(conn, f"SELECT count(*) AS c FROM coding_experiences{where_sql}", params)
        return {"items": [_row_to_experience(r) for r in rows], "total": int(count_row["c"]) if count_row else 0}

    @staticmethod
    def get(conn: sqlite3.Connection, eid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM coding_experiences WHERE id = ?", (eid,))
        return _row_to_experience(row) if row else None

    @staticmethod
    def create(
        conn: sqlite3.Connection,
        *,
        title: str,
        problem_description: str,
        solution_pattern: str,
        project_type: Optional[str] = None,
        framework: Optional[str] = None,
        framework_versions: Optional[list] = None,
        files_involved: Optional[list] = None,
        tags: Optional[list] = None,
        status: str = "proposed",
        confidence: int = 0,
        conversation_id: Optional[str] = None,
        project_id: Optional[str] = None,
        source: str = "agent",
    ) -> dict:
        if status not in EXPERIENCE_STATUSES:
            raise ValueError(f"unknown status: {status}")
        _validate_title(title)
        _validate_content(problem_description, "problem_description")
        _validate_content(solution_pattern, "solution_pattern")
        if looks_like_secret(problem_description) or looks_like_secret(solution_pattern) or looks_like_secret(title):
            raise ValueError("Refusing to store content that looks like a secret/credential.")
        tag_list = _normalize_tags(tags)
        fv_list = _normalize_string_list(framework_versions, MAX_FRAMEWORK_VERSIONS_COUNT)
        files_list = _normalize_string_list(files_involved, MAX_FILES_COUNT)
        eid = uid("exp")
        ts = now_ms()
        confirmed_at = ts if status == "confirmed" else None
        execute(
            conn,
            """
            INSERT INTO coding_experiences
              (id, title, problem_description, solution_pattern, project_type,
               framework, framework_versions, files_involved, tags, status,
               confidence, times_reused, conversation_id, project_id, source,
               failure_note, created_at, updated_at, confirmed_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (eid, title, problem_description, solution_pattern, project_type,
             framework, dumps(fv_list), dumps(files_list), dumps(tag_list), status,
             confidence, 0, conversation_id, project_id, source,
             None, ts, ts, confirmed_at),
        )
        return ExperienceRepo.get(conn, eid)  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        eid: str,
        *,
        title: Optional[str] = None,
        problem_description: Optional[str] = None,
        solution_pattern: Optional[str] = None,
        project_type: ... = ...,
        framework: ... = ...,
        framework_versions: ... = ...,
        files_involved: ... = ...,
        tags: ... = ...,
        status: Optional[str] = None,
        confidence: Optional[int] = None,
        failure_note: ... = ...,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM coding_experiences WHERE id = ?", (eid,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if title is not None:
            _validate_title(title)
            if looks_like_secret(title):
                raise ValueError("Refusing to store content that looks like a secret.")
            sets.append("title = ?")
            vals.append(title)
        if problem_description is not None:
            _validate_content(problem_description, "problem_description")
            if looks_like_secret(problem_description):
                raise ValueError("Refusing to store content that looks like a secret.")
            sets.append("problem_description = ?")
            vals.append(problem_description)
        if solution_pattern is not None:
            _validate_content(solution_pattern, "solution_pattern")
            if looks_like_secret(solution_pattern):
                raise ValueError("Refusing to store content that looks like a secret.")
            sets.append("solution_pattern = ?")
            vals.append(solution_pattern)
        if project_type is not ...:
            sets.append("project_type = ?")
            vals.append(project_type)
        if framework is not ...:
            sets.append("framework = ?")
            vals.append(framework)
        if framework_versions is not ...:
            sets.append("framework_versions = ?")
            vals.append(dumps(_normalize_string_list(framework_versions, MAX_FRAMEWORK_VERSIONS_COUNT)))
        if files_involved is not ...:
            sets.append("files_involved = ?")
            vals.append(dumps(_normalize_string_list(files_involved, MAX_FILES_COUNT)))
        if tags is not ...:
            sets.append("tags = ?")
            vals.append(dumps(_normalize_tags(tags)))
        if status is not None:
            if status not in EXPERIENCE_STATUSES:
                raise ValueError(f"unknown status: {status}")
            sets.append("status = ?")
            vals.append(status)
            if status == "confirmed":
                sets.append("confirmed_at = ?")
                vals.append(now_ms())
            elif status == "failed":
                pass
        if confidence is not None:
            sets.append("confidence = ?")
            vals.append(max(-5, min(10, int(confidence))))
        if failure_note is not ...:
            note = failure_note.strip()[:2000] if failure_note else None
            sets.append("failure_note = ?")
            vals.append(note)
        if not sets:
            return _row_to_experience(row)
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(eid)
        execute(conn, f"UPDATE coding_experiences SET {', '.join(sets)} WHERE id = ?", vals)
        return ExperienceRepo.get(conn, eid)

    @staticmethod
    def increment_reuse(conn: sqlite3.Connection, eid: str) -> None:
        execute(conn, "UPDATE coding_experiences SET times_reused = times_reused + 1, updated_at = ? WHERE id = ?", (now_ms(), eid))

    @staticmethod
    def remove(conn: sqlite3.Connection, eid: str) -> bool:
        cur = execute(conn, "DELETE FROM coding_experiences WHERE id = ?", (eid,))
        return cur.rowcount > 0

    @staticmethod
    def find_similar(
        conn: sqlite3.Connection,
        *,
        message: str,
        project_id: Optional[str] = None,
        framework: Optional[str] = None,
        limit: int = 5,
    ) -> list[dict]:
        """Find experiences that match the message via FTS, filtered by project
        and framework. Only returns 'confirmed' or 'proposed' experiences."""
        if not message or not message.strip():
            return []
        limit = max(1, min(limit, 20))
        where = ["status IN ('confirmed','proposed')"]
        params: list = []
        if project_id:
            where.append("(project_id = ? OR project_id IS NULL)")
            params.append(project_id)
        if framework:
            where.append("(framework = ? OR framework IS NULL)")
            params.append(framework)

        q = message.strip()
        if _fts_available(conn):
            phrase = '"' + q.replace('"', '""') + '"'
            where_sql = " AND " + " AND ".join(where)
            try:
                rows = query_all(
                    conn,
                    f"""
                    SELECT e.* FROM experiences_fts f
                    JOIN coding_experiences e ON e.rowid = f.rowid
                    WHERE experiences_fts MATCH ?{where_sql}
                    ORDER BY rank ASC
                    LIMIT ?
                    """,
                    [phrase, *params, limit],
                )
                return [_row_to_experience(r) for r in rows]
            except sqlite3.OperationalError:
                pass

        like = f"%{q[:100]}%"
        where.append("(title LIKE ? OR problem_description LIKE ? OR solution_pattern LIKE ?)")
        params.extend([like, like, like])
        where_sql = " WHERE " + " AND ".join(where)
        rows = query_all(
            conn,
            f"SELECT * FROM coding_experiences{where_sql} ORDER BY confidence DESC, updated_at DESC LIMIT ?",
            [*params, limit],
        )
        return [_row_to_experience(r) for r in rows]


# --- DecisionLogRepo ---

class DecisionLogRepo:
    @staticmethod
    def log(
        conn: sqlite3.Connection,
        *,
        request_id: str,
        conversation_id: Optional[str] = None,
        decision: str,
        reason: str = "",
        experience_id: Optional[str] = None,
        project_id: Optional[str] = None,
        framework: Optional[str] = None,
        confidence: int = 0,
        success: Optional[bool] = None,
        duration_ms: Optional[int] = None,
    ) -> dict:
        if decision not in DECISION_TYPES:
            raise ValueError(f"unknown decision type: {decision}")
        lid = uid("dec")
        ts = now_ms()
        execute(
            conn,
            """
            INSERT INTO agent_decision_log
              (id, request_id, conversation_id, decision, reason,
               experience_id, project_id, framework, confidence,
               success, duration_ms, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            """,
            (lid, request_id, conversation_id, decision, reason[:500],
             experience_id, project_id, framework, confidence,
             int(success) if success is not None else None,
             duration_ms, ts),
        )
        return {
            "id": lid, "requestId": request_id, "conversationId": conversation_id,
            "decision": decision, "reason": reason[:500], "experienceId": experience_id,
            "projectId": project_id, "framework": framework, "confidence": confidence,
            "success": success, "durationMs": duration_ms, "createdAt": ts,
        }

    @staticmethod
    def stats(conn: sqlite3.Connection) -> dict:
        """Summary stats for measuring Gemini savings."""
        rows = query_all(
            conn,
            """
            SELECT decision, count(*) AS cnt,
                   sum(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS successes,
                   sum(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failures
            FROM agent_decision_log
            GROUP BY decision
            """,
            [],
        )
        out: dict = {}
        for r in rows:
            out[r["decision"]] = {
                "count": int(r["cnt"]),
                "successes": int(r["successes"] or 0),
                "failures": int(r["failures"] or 0),
            }
        total_local = out.get("local_experience", {}).get("count", 0)
        total_gemini = out.get("gemini", {}).get("count", 0)
        total_all = total_local + total_gemini + out.get("simulation", {}).get("count", 0)
        out["total"] = total_all
        out["gemini_calls_saved"] = total_local
        out["savings_ratio"] = (total_local / total_all) if total_all > 0 else 0.0
        return out


# --- Validation helpers ---

def _validate_title(title: str) -> None:
    if not isinstance(title, str) or not title.strip():
        raise ValueError("title is required.")
    if len(title) > MAX_TITLE_CHARS:
        raise ValueError(f"title too long (max {MAX_TITLE_CHARS} chars).")


def _validate_content(content: str, field_name: str = "content") -> None:
    if not isinstance(content, str) or not content.strip():
        raise ValueError(f"{field_name} is required.")
    if len(content) > MAX_CONTENT_CHARS:
        raise ValueError(f"{field_name} too long (max {MAX_CONTENT_CHARS} chars).")
