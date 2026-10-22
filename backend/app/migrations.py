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
    (
        "0005_terminal_sessions",
        """
        -- Phase 10: real terminal / process execution sessions.
        -- Records metadata for each executed process. Output is NOT stored here —
        -- only bounded metadata (status, exit code, timing, truncation flags).
        -- Output streaming goes over WebSocket and is kept in-memory, optionally
        -- flushed to a bounded on-disk ring buffer per session.
        CREATE TABLE IF NOT EXISTS terminal_sessions (
            id TEXT PRIMARY KEY,
            project_id TEXT,
            command TEXT NOT NULL,
            working_dir TEXT NOT NULL,
            shell TEXT,
            kind TEXT NOT NULL DEFAULT 'command'
                CHECK (kind IN ('command','run','test','build','typecheck','lint','deps','preview')),
            source TEXT NOT NULL DEFAULT 'user'
                CHECK (source IN ('user','ai_proposed')),
            long_running INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','running','completed','failed','stopped','timeout')),
            exit_code INTEGER,
            started_at INTEGER NOT NULL,
            finished_at INTEGER,
            output_chars INTEGER NOT NULL DEFAULT 0,
            truncated INTEGER NOT NULL DEFAULT 0,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_term_sessions_project ON terminal_sessions(project_id);
        CREATE INDEX IF NOT EXISTS idx_term_sessions_status ON terminal_sessions(status);
        CREATE INDEX IF NOT EXISTS idx_term_sessions_started ON terminal_sessions(started_at DESC);

        -- Bounded snippet of the most recent output for a session, for the UI to
        -- restore state after a reconnect. Not a full transcript log.
        CREATE TABLE IF NOT EXISTS terminal_output_snippets (
            session_id TEXT PRIMARY KEY,
            tail_text TEXT NOT NULL DEFAULT '',
            tail_chars INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (session_id) REFERENCES terminal_sessions(id) ON DELETE CASCADE
        );

        -- Detected project runtime profile (cached). One row per project.
        CREATE TABLE IF NOT EXISTS project_runtime (
            project_id TEXT PRIMARY KEY,
            runtime TEXT NOT NULL DEFAULT 'unknown',
            language TEXT,
            framework TEXT,
            package_manager TEXT,
            manifest TEXT,
            detected_at INTEGER NOT NULL,
            details TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        """,
    ),
    (
        "0006_snapshots_proposals",
        """
        -- Phase 12: bounded file snapshots for undo/recovery.
        -- Stores the previous content of a file before each write so the user
        -- can restore the last known-good state. NOT a full VCS — only the most
        -- recent snapshot per (project_id, rel_path) is kept.
        CREATE TABLE IF NOT EXISTS file_snapshots (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            rel_path TEXT NOT NULL,
            content TEXT NOT NULL,
            content_chars INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            note TEXT,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        -- One snapshot per (project, path): upsert replaces on conflict.
        CREATE UNIQUE INDEX IF NOT EXISTS idx_snapshots_project_path
            ON file_snapshots(project_id, rel_path);
        CREATE INDEX IF NOT EXISTS idx_snapshots_project ON file_snapshots(project_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_created ON file_snapshots(created_at DESC);

        -- Phase 12: change proposals from AI diagnosis / agent.
        -- Records AI-proposed {path, original, updated} changes before the user
        -- reviews and approves them. Cleared when applied or dismissed.
        CREATE TABLE IF NOT EXISTS change_proposals (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            diagnosis_id TEXT,
            rel_path TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            original_snippet TEXT NOT NULL DEFAULT '',
            updated_snippet TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','applied','dismissed')),
            created_at INTEGER NOT NULL,
            applied_at INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_proposals_project ON change_proposals(project_id);
        CREATE INDEX IF NOT EXISTS idx_proposals_status ON change_proposals(status);
        """,
    ),
    (
        "0007_connection_diagnostics",
        """
        -- Connection diagnostic events. Stores structured, sanitized logs for
        -- connection lifecycle and AI request events. NEVER contains API keys,
        -- authorization headers, or raw request/response bodies.
        CREATE TABLE IF NOT EXISTS connection_diagnostics (
            id TEXT PRIMARY KEY,
            event_type TEXT NOT NULL,
            connection_id TEXT,
            provider_id TEXT,
            model TEXT,
            status TEXT,
            duration_ms INTEGER,
            message TEXT NOT NULL DEFAULT '',
            details TEXT NOT NULL DEFAULT '{}',
            created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_diag_connection ON connection_diagnostics(connection_id);
        CREATE INDEX IF NOT EXISTS idx_diag_type ON connection_diagnostics(event_type);
        CREATE INDEX IF NOT EXISTS idx_diag_created ON connection_diagnostics(created_at DESC);
        """,
    ),
    (
        "0008_coding_experiences",
        """
        -- Coding experiences learned by the Agent. Each record captures a
        -- reusable solution pattern, problem context, and outcome. Distinct
        -- from memories/knowledge: experiences are structured, outcome-tracked,
        -- and reusable for reducing Gemini calls.
        CREATE TABLE IF NOT EXISTS coding_experiences (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            problem_description TEXT NOT NULL,
            solution_pattern TEXT NOT NULL,
            project_type TEXT,
            framework TEXT,
            framework_versions TEXT NOT NULL DEFAULT '[]',
            files_involved TEXT NOT NULL DEFAULT '[]',
            tags TEXT NOT NULL DEFAULT '[]',
            status TEXT NOT NULL DEFAULT 'proposed'
                CHECK (status IN ('proposed','confirmed','failed','superseded')),
            confidence INTEGER NOT NULL DEFAULT 0,
            times_reused INTEGER NOT NULL DEFAULT 0,
            conversation_id TEXT,
            project_id TEXT,
            source TEXT NOT NULL DEFAULT 'agent',
            failure_note TEXT,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            confirmed_at INTEGER,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_exp_project ON coding_experiences(project_id);
        CREATE INDEX IF NOT EXISTS idx_exp_status ON coding_experiences(status);
        CREATE INDEX IF NOT EXISTS idx_exp_framework ON coding_experiences(framework);
        CREATE INDEX IF NOT EXISTS idx_exp_confidence ON coding_experiences(confidence DESC);

        -- FTS index for experiences.
        CREATE VIRTUAL TABLE IF NOT EXISTS experiences_fts USING fts5(
            title, problem_description, solution_pattern, tags,
            content='coding_experiences',
            content_rowid='rowid',
            tokenize='porter unicode61 remove_diacritics 1'
        );
        CREATE TRIGGER IF NOT EXISTS exp_ai AFTER INSERT ON coding_experiences BEGIN
            INSERT INTO experiences_fts(rowid, title, problem_description, solution_pattern, tags)
            VALUES (new.rowid, new.title, new.problem_description, new.solution_pattern, new.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS exp_ad AFTER DELETE ON coding_experiences BEGIN
            INSERT INTO experiences_fts(experiences_fts, rowid, title, problem_description, solution_pattern, tags)
            VALUES ('delete', old.rowid, old.title, old.problem_description, old.solution_pattern, old.tags);
        END;
        CREATE TRIGGER IF NOT EXISTS exp_au AFTER UPDATE ON coding_experiences BEGIN
            INSERT INTO experiences_fts(experiences_fts, rowid, title, problem_description, solution_pattern, tags)
            VALUES ('delete', old.rowid, old.title, old.problem_description, old.solution_pattern, old.tags);
            INSERT INTO experiences_fts(rowid, title, problem_description, solution_pattern, tags)
            VALUES (new.rowid, new.title, new.problem_description, new.solution_pattern, new.tags);
        END;

        -- Agent decision log: records whether each request used Gemini or a
        -- local experience, and why. Used for measuring savings.
        CREATE TABLE IF NOT EXISTS agent_decision_log (
            id TEXT PRIMARY KEY,
            request_id TEXT NOT NULL,
            conversation_id TEXT,
            decision TEXT NOT NULL CHECK (decision IN ('local_experience','gemini','simulation')),
            reason TEXT NOT NULL DEFAULT '',
            experience_id TEXT,
            project_id TEXT,
            framework TEXT,
            confidence INTEGER NOT NULL DEFAULT 0,
            success INTEGER,
            duration_ms INTEGER,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (experience_id) REFERENCES coding_experiences(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_deci_request ON agent_decision_log(request_id);
        CREATE INDEX IF NOT EXISTS idx_deci_decision ON agent_decision_log(decision);
        CREATE INDEX IF NOT EXISTS idx_deci_created ON agent_decision_log(created_at DESC);
        """,
    ),
    (
        "0009_model_profiles",
        """
        -- Model profiles (fallback chains). A profile is a named, ordered list
        -- of candidate models drawn from configured connections. When a request
        -- fails on the primary candidate, the next eligible candidate is tried.
        -- A profile can be selected per-project or per-task.
        CREATE TABLE IF NOT EXISTS model_profiles (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            enabled INTEGER NOT NULL DEFAULT 1,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        -- Ordered candidates within a profile. Each references a specific
        -- connection + model_id. priority is a 1-based ordinal (1 = primary).
        CREATE TABLE IF NOT EXISTS profile_candidates (
            id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            connection_id TEXT NOT NULL,
            model_id TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 1,
            enabled INTEGER NOT NULL DEFAULT 1,
            label TEXT,
            created_at INTEGER NOT NULL,
            FOREIGN KEY (profile_id) REFERENCES model_profiles(id) ON DELETE CASCADE,
            FOREIGN KEY (connection_id) REFERENCES api_connections(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_pc_profile ON profile_candidates(profile_id);
        CREATE INDEX IF NOT EXISTS idx_pc_priority ON profile_candidates(profile_id, priority ASC);

        -- Optional per-project profile assignment. When set, the project's
        -- agent requests use this profile's fallback chain instead of the
        -- default connection/model. When absent, the agent default is used.
        CREATE TABLE IF NOT EXISTS project_profile_assignments (
            project_id TEXT PRIMARY KEY,
            profile_id TEXT NOT NULL,
            assigned_at INTEGER NOT NULL,
            FOREIGN KEY (profile_id) REFERENCES model_profiles(id) ON DELETE CASCADE,
            FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
        );

        -- Default profile for new conversations (single row, like agent_defaults).
        CREATE TABLE IF NOT EXISTS default_profile (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            profile_id TEXT,
            FOREIGN KEY (profile_id) REFERENCES model_profiles(id) ON DELETE SET NULL
        );
        INSERT OR IGNORE INTO default_profile (id) VALUES (1);
        """,
    ),
]
