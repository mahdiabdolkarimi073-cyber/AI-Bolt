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
    (
        "0003_memory_knowledge",
        """
        -- Persistent conversation memory.
        -- Stores durable facts, preferences, conventions, and notes learned
        -- from conversations or entered manually. Distinct from project
        -- knowledge: a memory is personal/general unless tied to a project.
        CREATE TABLE IF NOT EXISTS memories (
            id TEXT PRIMARY KEY,
            type TEXT NOT NULL CHECK (type IN (
                'preference','convention','decision','constraint',
                'instruction','task','fact','note'
            )),
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            project_id TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            importance INTEGER NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            last_accessed_at INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);
        CREATE INDEX IF NOT EXISTS idx_memories_active ON memories(active);
        CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);

        -- Project knowledge base entries.
        -- Durable project-scoped documentation: summaries, architecture
        -- decisions, conventions, limitations. Never leaks across projects
        -- unless project_id is NULL (globally applicable).
        CREATE TABLE IF NOT EXISTS knowledge_entries (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            category TEXT NOT NULL CHECK (category IN (
                'summary','architecture','convention','limitation',
                'documentation','note','other'
            )),
            project_id TEXT,
            tags TEXT NOT NULL DEFAULT '[]',
            source TEXT,
            active INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(project_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_active ON knowledge_entries(active);
        CREATE INDEX IF NOT EXISTS idx_knowledge_category ON knowledge_entries(category);

        -- Full-text search indexes (FTS5). External content tables so the
        -- canonical rows in memories/knowledge_entries remain the source of
        -- truth; the FTS indexes are kept in sync via triggers.
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
            title, content, tags,
            content='memories',
            content_rowid='rowid',
            tokenize='porter unicode61 remove_diacritics 1'
        );
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
            INSERT INTO memories_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
            VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
            INSERT INTO memories_fts(memories_fts, rowid, title, content, tags)
            VALUES ('delete', old.rowid, old.title, old.content, old.tags);
            INSERT INTO memories_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;

        CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
            title, content, tags,
            content='knowledge_entries',
            content_rowid='rowid',
            tokenize='porter unicode61 remove_diacritics 1'
        );
        CREATE TRIGGER IF NOT EXISTS knowledge_ai AFTER INSERT ON knowledge_entries BEGIN
            INSERT INTO knowledge_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_ad AFTER DELETE ON knowledge_entries BEGIN
            INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
            VALUES ('delete', old.rowid, old.title, old.content, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS knowledge_au AFTER UPDATE ON knowledge_entries BEGIN
            INSERT INTO knowledge_fts(knowledge_fts, rowid, title, content, tags)
            VALUES ('delete', old.rowid, old.title, old.content, old.tags);
            INSERT INTO knowledge_fts(rowid, title, content, tags)
            VALUES (new.rowid, new.title, new.content, new.tags);
        END;
        """,
    ),
    (
        "0004_workspace_projects",
        """
        -- Phase 9: on-disk workspace storage for imported projects.
        -- `workspace_path` is the directory name under WORKSPACE_ROOT where the
        -- project's files actually live. It is distinct from the legacy `path`
        -- column (kept for backward compatibility). `import_source` records how
        -- the project was created ('zip' | 'empty' | 'folder').
        ALTER TABLE projects ADD COLUMN workspace_path TEXT;
        ALTER TABLE projects ADD COLUMN import_source TEXT NOT NULL DEFAULT 'manual';
        ALTER TABLE projects ADD COLUMN last_opened_at INTEGER;

        -- Recent-projects ordering. A project may appear here even after its
        -- files are removed from disk; the UI distinguishes "registered" from
        -- "available". Removing a row here does NOT delete on-disk files.
        CREATE TABLE IF NOT EXISTS recent_projects (
            project_id TEXT PRIMARY KEY,
            opened_at INTEGER NOT NULL,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_recent_opened ON recent_projects(opened_at DESC);
        """,
    ),
]
