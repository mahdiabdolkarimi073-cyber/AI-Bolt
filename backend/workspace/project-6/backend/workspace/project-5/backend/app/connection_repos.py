"""Data-access layer for API connections, credentials, and models.

Secrets (API keys) are stored encrypted (see app.crypto) and NEVER returned in
list/detail responses. Only non-sensitive metadata (mask, label, enabled,
primary) is exposed to the frontend.
"""
from __future__ import annotations

import sqlite3
from typing import Optional

from app.crypto import encrypt, decrypt, mask_key, EncryptionError
from app.db import query_all, query_one, execute
from app.utils import uid, now_ms, dumps, loads


ADAPTERS = ("openai_compatible", "gemini")


def _row_to_connection(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "displayName": row["display_name"],
        "adapter": row["adapter"],
        "providerLabel": row["provider_label"],
        "baseUrl": row["base_url"],
        "enabled": bool(row["enabled"]),
        "status": row["status"],
        "defaultModel": row["default_model"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def _row_to_model(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "connectionId": row["connection_id"],
        "modelId": row["model_id"],
        "label": row["label"],
        "enabled": bool(row["enabled"]),
        "isDefault": bool(row["is_default"]),
        "createdAt": row["created_at"],
    }


def _row_to_credential(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "connectionId": row["connection_id"],
        "label": row["label"],
        "keyMask": row["key_mask"],
        "enabled": bool(row["enabled"]),
        "isPrimary": bool(row["is_primary"]),
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


class ConnectionRepo:
    @staticmethod
    def list(conn: sqlite3.Connection) -> list[dict]:
        rows = query_all(conn, "SELECT * FROM api_connections ORDER BY created_at ASC")
        return [_row_to_connection(r) for r in rows]

    @staticmethod
    def get(conn: sqlite3.Connection, cid: str) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM api_connections WHERE id = ?", (cid,))
        return _row_to_connection(row) if row else None

    @staticmethod
    def create(
        conn: sqlite3.Connection,
        *,
        display_name: str,
        adapter: str,
        provider_label: Optional[str],
        base_url: Optional[str],
        enabled: bool = True,
    ) -> dict:
        if adapter not in ADAPTERS:
            raise ValueError(f"Unknown adapter: {adapter}")
        cid = uid("conn")
        ts = now_ms()
        execute(
            conn,
            """
            INSERT INTO api_connections
              (id, display_name, adapter, provider_label, base_url, enabled, status, default_model, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)
            """,
            (cid, display_name, adapter, provider_label, base_url, int(enabled), "untested", None, ts, ts),
        )
        return ConnectionRepo.get(conn, cid)  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        cid: str,
        *,
        display_name: Optional[str] = None,
        provider_label: Optional[str] = ...,
        base_url: Optional[str] = ...,
        enabled: Optional[bool] = None,
        status: Optional[str] = None,
        default_model: Optional[str] = ...,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM api_connections WHERE id = ?", (cid,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if display_name is not None:
            sets.append("display_name = ?")
            vals.append(display_name)
        if provider_label is not ...:
            sets.append("provider_label = ?")
            vals.append(provider_label)
        if base_url is not ...:
            sets.append("base_url = ?")
            vals.append(base_url)
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(int(enabled))
        if status is not None:
            sets.append("status = ?")
            vals.append(status)
        if default_model is not ...:
            sets.append("default_model = ?")
            vals.append(default_model)
        if not sets:
            return _row_to_connection(row)
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(cid)
        execute(conn, f"UPDATE api_connections SET {', '.join(sets)} WHERE id = ?", vals)
        return ConnectionRepo.get(conn, cid)

    @staticmethod
    def remove(conn: sqlite3.Connection, cid: str) -> bool:
        cur = execute(conn, "DELETE FROM api_connections WHERE id = ?", (cid,))
        return cur.rowcount > 0


class ConnectionModelRepo:
    @staticmethod
    def list(conn: sqlite3.Connection, connection_id: str) -> list[dict]:
        rows = query_all(
            conn,
            "SELECT * FROM connection_models WHERE connection_id = ? ORDER BY created_at ASC",
            (connection_id,),
        )
        return [_row_to_model(r) for r in rows]

    @staticmethod
    def add(
        conn: sqlite3.Connection,
        *,
        connection_id: str,
        model_id: str,
        label: Optional[str] = None,
        enabled: bool = True,
        is_default: bool = False,
    ) -> dict:
        mid = uid("mdl")
        ts = now_ms()
        if is_default:
            # Only one default per connection.
            execute(
                conn,
                "UPDATE connection_models SET is_default = 0 WHERE connection_id = ?",
                (connection_id,),
            )
        execute(
            conn,
            """
            INSERT INTO connection_models
              (id, connection_id, model_id, label, enabled, is_default, created_at)
            VALUES (?,?,?,?,?,?,?)
            """,
            (mid, connection_id, model_id, label, int(enabled), int(is_default), ts),
        )
        # Update the connection's default_model pointer when is_default.
        if is_default:
            execute(
                conn,
                "UPDATE api_connections SET default_model = ?, updated_at = ? WHERE id = ?",
                (model_id, ts, connection_id),
            )
        return _row_to_model(query_one(conn, "SELECT * FROM connection_models WHERE id = ?", (mid,)))  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        model_db_id: str,
        *,
        label: Optional[str] = ...,
        enabled: Optional[bool] = None,
        is_default: Optional[bool] = None,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM connection_models WHERE id = ?", (model_db_id,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if label is not ...:
            sets.append("label = ?")
            vals.append(label)
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(int(enabled))
        if is_default is not None:
            if is_default:
                execute(
                    conn,
                    "UPDATE connection_models SET is_default = 0 WHERE connection_id = ?",
                    (row["connection_id"],),
                )
            sets.append("is_default = ?")
            vals.append(int(is_default))
        if not sets:
            return _row_to_model(row)
        if sets:
            execute(conn, f"UPDATE connection_models SET {', '.join(sets)} WHERE id = ?", [*vals, model_db_id])
        if is_default:
            ts = now_ms()
            new_row = query_one(conn, "SELECT * FROM connection_models WHERE id = ?", (model_db_id,))
            if new_row:
                execute(
                    conn,
                    "UPDATE api_connections SET default_model = ?, updated_at = ? WHERE id = ?",
                    (new_row["model_id"], ts, new_row["connection_id"]),
                )
        return _row_to_model(query_one(conn, "SELECT * FROM connection_models WHERE id = ?", (model_db_id,)))  # type: ignore[return-value]

    @staticmethod
    def remove(conn: sqlite3.Connection, model_db_id: str) -> bool:
        cur = execute(conn, "DELETE FROM connection_models WHERE id = ?", (model_db_id,))
        return cur.rowcount > 0


class CredentialRepo:
    @staticmethod
    def list(conn: sqlite3.Connection, connection_id: str) -> list[dict]:
        rows = query_all(
            conn,
            "SELECT * FROM connection_credentials WHERE connection_id = ? ORDER BY created_at ASC",
            (connection_id,),
        )
        return [_row_to_credential(r) for r in rows]

    @staticmethod
    def add(
        conn: sqlite3.Connection,
        *,
        connection_id: str,
        secret: str,
        label: Optional[str] = None,
        enabled: bool = True,
        is_primary: bool = False,
    ) -> dict:
        """Encrypt and store a credential. Never stores plaintext."""
        try:
            enc = encrypt(secret)
        except EncryptionError as exc:
            raise ValueError(str(exc)) from exc
        kid = uid("cred")
        ts = now_ms()
        if is_primary:
            execute(
                conn,
                "UPDATE connection_credentials SET is_primary = 0 WHERE connection_id = ?",
                (connection_id,),
            )
        execute(
            conn,
            """
            INSERT INTO connection_credentials
              (id, connection_id, label, encrypted_secret, key_mask, enabled, is_primary, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)
            """,
            (kid, connection_id, label, enc, mask_key(secret), int(enabled), int(is_primary), ts, ts),
        )
        return _row_to_credential(query_one(conn, "SELECT * FROM connection_credentials WHERE id = ?", (kid,)))  # type: ignore[return-value]

    @staticmethod
    def update(
        conn: sqlite3.Connection,
        cred_id: str,
        *,
        label: Optional[str] = ...,
        enabled: Optional[bool] = None,
        is_primary: Optional[bool] = None,
    ) -> Optional[dict]:
        row = query_one(conn, "SELECT * FROM connection_credentials WHERE id = ?", (cred_id,))
        if not row:
            return None
        sets: list[str] = []
        vals: list = []
        if label is not ...:
            sets.append("label = ?")
            vals.append(label)
        if enabled is not None:
            sets.append("enabled = ?")
            vals.append(int(enabled))
        if is_primary is not None:
            if is_primary:
                execute(
                    conn,
                    "UPDATE connection_credentials SET is_primary = 0 WHERE connection_id = ?",
                    (row["connection_id"],),
                )
            sets.append("is_primary = ?")
            vals.append(int(is_primary))
        if not sets:
            return _row_to_credential(row)
        sets.append("updated_at = ?")
        vals.append(now_ms())
        vals.append(cred_id)
        execute(conn, f"UPDATE connection_credentials SET {', '.join(sets)} WHERE id = ?", vals)
        return _row_to_credential(query_one(conn, "SELECT * FROM connection_credentials WHERE id = ?", (cred_id,)))

    @staticmethod
    def remove(conn: sqlite3.Connection, cred_id: str) -> bool:
        cur = execute(conn, "DELETE FROM connection_credentials WHERE id = ?", (cred_id,))
        return cur.rowcount > 0

    @staticmethod
    def get_secret(conn: sqlite3.Connection, cred_id: str) -> Optional[str]:
        """Decrypt and return the plaintext secret. Backend-only; never sent
        to the browser. Raises EncryptionError if decryption fails.
        """
        row = query_one(conn, "SELECT * FROM connection_credentials WHERE id = ?", (cred_id,))
        if not row:
            return None
        return decrypt(row["encrypted_secret"])

    @staticmethod
    def select_secret(conn: sqlite3.Connection, connection_id: str) -> tuple[Optional[str], Optional[dict]]:
        """Select a credential to use for a connection.

        Strategy: primary enabled key first; otherwise the first enabled key.
        Returns (plaintext_secret, credential_meta) or (None, None) if no
        enabled key exists.
        """
        rows = query_all(
            conn,
            "SELECT * FROM connection_credentials WHERE connection_id = ? AND enabled = 1 ORDER BY is_primary DESC, created_at ASC",
            (connection_id,),
        )
        for row in rows:
            try:
                secret = decrypt(row["encrypted_secret"])
                return secret, _row_to_credential(row)
            except EncryptionError:
                # Skip undecryptable credentials; failover to the next key.
                continue
        return None, None


class AgentDefaultsRepo:
    @staticmethod
    def get(conn: sqlite3.Connection) -> dict:
        row = query_one(conn, "SELECT * FROM agent_defaults WHERE id = 1")
        return {"connectionId": row["connection_id"] if row else None, "model": row["model"] if row else None}

    @staticmethod
    def set(conn: sqlite3.Connection, *, connection_id: Optional[str], model: Optional[str]) -> dict:
        execute(
            conn,
            "INSERT INTO agent_defaults (id, connection_id, model) VALUES (1, ?, ?) "
            "ON CONFLICT(id) DO UPDATE SET connection_id = excluded.connection_id, model = excluded.model",
            (connection_id, model),
        )
        return AgentDefaultsRepo.get(conn)
