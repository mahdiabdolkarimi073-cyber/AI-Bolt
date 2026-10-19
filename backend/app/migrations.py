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
    (
        "0002_connections",
        """
        -- API connections. A connection is a user-defined configuration that
        -- binds an adapter (protocol) to a base URL and a set of credentials +
        -- models. Connection identity is separate from provider identity: a
        -- user may create multiple GroqCloud connections with different keys.
        CREATE TABLE IF NOT EXISTS api_connections (
            id TEXT PRIMARY KEY,
            display_name TEXT NOT NULL,
            adapter TEXT NOT NULL CHECK (adapter IN ('openai_compatible','gemini')),
            provider_label TEXT,
            base_url TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            status TEXT NOT NULL DEFAULT 'untested',
            default_model TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Models configured for a connection. Manually entered or discovered.
        CREATE TABLE IF NOT EXISTS connection_models (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            label TEXT,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_default INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (connection_id) REFERENCES api_connections(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_conn_models_connection ON connection_models(connection_id);

        -- API credentials. The secret is stored encrypted (Fernet). Metadata
        -- (label, enabled, mask) is stored in plaintext for safe display.
        CREATE TABLE IF NOT EXISTS connection_credentials (
            id TEXT PRIMARY KEY,
            connection_id TEXT NOT NULL,
            label TEXT,
            encrypted_secret TEXT NOT NULL,
            key_mask TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 1,
            is_primary INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (connection_id) REFERENCES api_connections(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_credentials_connection ON connection_credentials(connection_id);

        -- Default connection + model for new Agent conversations. Single row.
        CREATE TABLE IF NOT EXISTS agent_defaults (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            connection_id TEXT,
            model TEXT,
            FOREIGN KEY (connection_id) REFERENCES api_connections(id) ON DELETE SET NULL
        );
        INSERT OR IGNORE INTO agent_defaults (id) VALUES (1);
        """,
    ),
]
