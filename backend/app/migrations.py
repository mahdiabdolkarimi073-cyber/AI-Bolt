"""Database migrations.

Each migration is (name, sql). SQL is executed via `executescript` and must be
idempotent (use IF NOT EXISTS). Migrations are applied in order and tracked in
`_migrations`. Never edit an applied migration — add a new one instead.
"""
from __future__ import annotations

MIGRATIONS: list[tuple[str, str]] = [
    (
        "0001_initial",
        """
        CREATE TABLE IF NOT EXISTS projects (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            path TEXT NOT NULL,
            template TEXT NOT NULL DEFAULT 'blank',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS conversations (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            title TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
            content TEXT NOT NULL,
            steps TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);

        CREATE TABLE IF NOT EXISTS provider_configs (
            id TEXT PRIMARY KEY,
            enabled INTEGER NOT NULL DEFAULT 0,
            model TEXT NOT NULL,
            base_url TEXT,
            api_key TEXT,
            updated_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
        );

        CREATE TABLE IF NOT EXISTS settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            active_provider TEXT NOT NULL DEFAULT 'gemini',
            active_project_id TEXT,
            theme TEXT NOT NULL DEFAULT 'dark',
            font_size INTEGER NOT NULL DEFAULT 13,
            tab_size INTEGER NOT NULL DEFAULT 2
        );
        INSERT OR IGNORE INTO settings (id) VALUES (1);
        """,
    ),
]
