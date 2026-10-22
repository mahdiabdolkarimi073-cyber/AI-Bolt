"""Data-access layer for model profiles (fallback chains).

A profile is a named, ordered list of candidate models. Each candidate
references a configured connection + model_id. When the primary candidate
fails, the next enabled candidate is tried automatically.

Secrets are never stored or returned here — candidates reference connections
by id, and credentials are resolved at request time through CredentialRepo.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from app.db import query_all, query_one, execute
from app.utils import uid, now_ms


def _row_to_profile(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "description": row["description"],
        "enabled": bool(row["enabled"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row_to_candidate(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "profileId": row["profile_id"],
        "connectionId": row["connection_id"],
        "modelId": row["model_id"],
        "priority": row["priority"],
        "enabled": bool(row["enabled"]),
        "label": row["label"],
        "createdAt": row["created_at"],
    }


class ProfileRepo:
    @staticmethod
    def list(conn: sqlite3.Connection) -> list[dict]:
        rows = query_all(conn, "SELECT * FROM model_profiles ORDER BY created_at ASC")
        profiles = [_row_to_profile(r) for r in rows]
        for p in profiles:
            p["candidates"] = ProfileCandidateRepo.list(conn, p["id"])
        return profiles

    @staticmethod
    def get(conn: sqlite3.Connection, pid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM model_profiles WHERE id = ?", (pid,))
        if not row:
            return None
        p = _row_to_profile(row)
        p["candidates"] = ProfileCandidateRepo.list(conn, pid)
        return p

    @staticmethod
    def create(conn: sqlite3.Connection, *, name: str, description: str = "") -> dict:
        pid = uid("prof")
        ts = now_ms()
        execute(
            conn,
            "INSERT INTO model_profiles (id, name, description, enabled, created_at, updated_at) VALUES (?,?,?,?,?,?)",
            (pid, name, description, 1, ts, ts),
        )
        return ProfileRepo.get(conn, pid)  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        pid: str,
        *,
        name: Optional[str] = None,
        description: Optional[str] = None,
        enabled: Optional[bool] = None,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM model_profiles WHERE id = ?", (pid,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if name is not None:
            sets.append("name = ?")
            vals.append(name)
        if description is not None:
            sets.append("description = ?")
            vals.append(description)
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(int(enabled))
        if not sets:
            return ProfileRepo.get(conn, pid)
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(pid)
        execute(conn, f"UPDATE model_profiles SET {', '.join(sets)} WHERE id = ?", vals)
        return ProfileRepo.get(conn, pid)

    @staticmethod
    def remove(conn: sqlite3.Connection, pid: str) -> bool:
        cur = execute(conn, "DELETE FROM model_profiles WHERE id = ?", (pid,))
        return cur.rowcount > 0


class ProfileCandidateRepo:
    @staticmethod
    def list(conn: sqlite3.Connection, profile_id: str) -> list[dict]:
        rows = query_all(
            conn,
            "SELECT * FROM profile_candidates WHERE profile_id = ? ORDER BY priority ASC, created_at ASC",
            (profile_id,),
        )
        return [_row_to_candidate(r) for r in rows]

    @staticmethod
    def add(
        conn: sqlite3.Connection,
        *,
        profile_id: str,
        connection_id: str,
        model_id: str,
        priority: int = 1,
        label: Optional[str] = None,
        enabled: bool = True,
    ) -> dict:
        cid = uid("cand")
        ts = now_ms()
        execute(
            conn,
            """INSERT INTO profile_candidates
                 (id, profile_id, connection_id, model_id, priority, enabled, label, created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (cid, profile_id, connection_id, model_id, priority, int(enabled), label, ts),
        )
        return _row_to_candidate(query_one(conn, "SELECT * FROM profile_candidates WHERE id = ?", (cid,)))  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        candidate_id: str,
        *,
        priority: Optional[int] = None,
        enabled: Optional[bool] = None,
        label: Optional[str] = ...,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM profile_candidates WHERE id = ?", (candidate_id,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if priority is not None:
            sets.append("priority = ?")
            vals.append(priority)
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(int(enabled))
        if label is not ...:
            sets.append("label = ?")
            vals.append(label)
        if not sets:
            return _row_to_candidate(row)
        execute(conn, f"UPDATE profile_candidates SET {', '.join(sets)} WHERE id = ?", [*vals, candidate_id])
        return _row_to_candidate(query_one(conn, "SELECT * FROM profile_candidates WHERE id = ?", (candidate_id,)))  # type: ignore[return-value]

    @staticmethod
    def remove(conn: sqlite3.Connection, candidate_id: str) -> bool:
        cur = execute(conn, "DELETE FROM profile_candidates WHERE id = ?", (candidate_id,))
        return cur.rowcount > 0

    @staticmethod
    def reorder(conn: sqlite3.Connection, profile_id: str, ordered_ids: list[str]) -> None:
        """Reassign priorities based on the order of ids in the list."""
        for idx, cid in enumerate(ordered_ids, start=1):
            execute(conn, "UPDATE profile_candidates SET priority = ? WHERE id = ? AND profile_id = ?", (idx, cid, profile_id))


class ProjectProfileAssignmentRepo:
    @staticmethod
    def get(conn: sqlite3.Connection, project_id: str) -> Optional[dict]:
        row = query_one(
            conn,
            """SELECT ppa.*, mp.name as profile_name, mp.enabled as profile_enabled
               FROM project_profile_assignments ppa
               JOIN model_profiles mp ON ppa.profile_id = mp.id
               WHERE ppa.project_id = ?""",
            (project_id,),
        )
        if not row:
            return None
        return {
            "projectId": row["project_id"],
            "profileId": row["profile_id"],
            "profileName": row["profile_name"],
            "profileEnabled": bool(row["profile_enabled"]),
            "assignedAt": row["assigned_at"],
        }

    @staticmethod
    def set(conn: sqlite3.Connection, project_id: str, profile_id: str) -> dict:
        ts = now_ms()
        execute(
            conn,
            "INSERT INTO project_profile_assignments (project_id, profile_id, assigned_at) VALUES (?,?,?) "
            "ON CONFLICT(project_id) DO UPDATE SET profile_id = excluded.profile_id, assigned_at = excluded.assigned_at",
            (project_id, profile_id, ts),
        )
        return ProjectProfileAssignmentRepo.get(conn, project_id)  # type: ignore[return-value]

    @staticmethod
    def clear(conn: sqlite3.Connection, project_id: str) -> bool:
        cur = execute(conn, "DELETE FROM project_profile_assignments WHERE project_id = ?", (project_id,))
        return cur.rowcount > 0


class DefaultProfileRepo:
    @staticmethod
    def get(conn: sqlite3.Connection) -> Optional[str]:
        row = query_one(conn, "SELECT * FROM default_profile WHERE id = 1")
        return row["profile_id"] if row else None

    @staticmethod
    def set(conn: sqlite3.Connection, profile_id: Optional[str]) -> Optional[str]:
        execute(
            conn,
            "INSERT INTO default_profile (id, profile_id) VALUES (1, ?) "
            "ON CONFLICT(id) DO UPDATE SET profile_id = excluded.profile_id",
            (profile_id,),
        )
        return DefaultProfileRepo.get(conn)


def resolve_candidates(conn: sqlite3.Connection, profile_id: str) -> list[dict]:
    """Return the ordered, enabled candidates for a profile, enriched with
    connection metadata (adapter, baseUrl, displayName, hasKey, enabled).

    Only candidates whose connection is enabled and has at least one enabled
    credential are included. The caller is responsible for selecting a secret.
    """
    from app.connection_repos import ConnectionRepo, CredentialRepo
    rows = query_all(
        conn,
        """SELECT pc.* FROM profile_candidates pc
           WHERE pc.profile_id = ? AND pc.enabled = 1
           ORDER BY pc.priority ASC, pc.created_at ASC""",
        (profile_id,),
    )
    candidates: list[dict] = []
    for row in rows:
        connection = ConnectionRepo.get(conn, row["connection_id"])
        if not connection or not connection["enabled"]:
            continue
        _, cred = CredentialRepo.select_secret(conn, connection["id"])
        if not cred:
            continue
        candidates.append({
            "candidateId": row["id"],
            "connectionId": row["connection_id"],
            "modelId": row["model_id"],
            "priority": row["priority"],
            "label": row["label"],
            "adapter": connection["adapter"],
            "baseUrl": connection["baseUrl"],
            "displayName": connection["displayName"],
            "connectionStatus": connection["status"],
        })
    return candidates
