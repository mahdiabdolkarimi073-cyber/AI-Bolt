# Personal AI IDE — Architecture

## Overview

Personal AI IDE is a private, AI-powered development environment designed to run
locally on a developer's machine (Windows, ~8 GB RAM, no GPU). The frontend is
a React + TypeScript + Tailwind app; an optional local Python (FastAPI + SQLite)
backend provides real persistence, workspace file access, and provider proxying.

This document describes the architecture established in **Stage 4** of the
project proposal. The UI was built in Stage 3 and is intentionally unchanged.

## High-level diagram

```
┌──────────────────────────────────────────────┐
│  Browser  (React + TS + Tailwind, Vite)       │
│                                               │
│  UI Components  ──►  Application Services     │
│                         │                     │
│            ┌────────────┼────────────┐        │
│            ▼            ▼            ▼        │
│      Repositories   Workspace    AIProvider   │
│      (contract)     Service      (contract)   │
│            │            │            │        │
│   ┌────────┴────────┐   │            │        │
│   ▼                 ▼   │            │        │
│ InMemory         Backend│            │        │
│ (localStorage)   Client │            │        │
│                  (HTTP) │            │        │
└──────────────────────────────────────────────┘
                     │            │
                     ▼            ▼
┌──────────────────────────────────────────────┐
│  Local FastAPI Backend  (Python, 127.0.0.1)   │
│                                               │
│  Routes ──► Repositories ──► SQLite           │
│  Workspace Routes ──► Security ──► Filesystem │
│  (API keys in backend/.env, never sent to     │
│   the browser)                                │
└──────────────────────────────────────────────┘
```

## Layer separation

The frontend is organized into clearly separated layers:

| Layer              | Location                       | Responsibility                                     |
|--------------------|--------------------------------|----------------------------------------------------|
| UI Components      | `src/components/`              | Display and interaction only. No business logic.   |
| Application Services | `src/services/`              | Repository contracts, provider adapters, workspace.|
| API Layer          | `src/lib/http.ts`              | Fetch wrapper, timeout, error normalization.       |
| Domain Types       | `src/types/`, `src/types.ts`   | Data contracts shared across layers.               |
| Persistence        | `src/services/repositories.ts` | Interface; two implementations (in-memory/backend).|
| Provider Adapters  | `src/services/providers/`      | `AIProvider` interface + stub adapters.            |
| Workspace Services | `src/services/workspace.ts`    | Validated file operations via backend.             |
| Configuration      | `src/config/`                  | Runtime config from env vars.                      |

UI components never call `fetch` or touch persistence directly. They go through
the repository contracts, so the same UI works both in browser fallback mode
and against the real backend.

## Dual-mode persistence

The app runs in one of two modes, decided at startup by `VITE_API_BASE_URL`:

1. **Browser fallback** (no backend URL): uses `inMemoryRepositories`, which
   persist to `localStorage`. This is what runs in the Bolt preview. Data
   survives reloads. There is no parallel backend store to conflict with.
2. **Backend mode** (`VITE_API_BASE_URL` set): uses `backendRepositories`,
   which call the FastAPI service. SQLite is the single source of truth.

There is **one** active store at a time — never two conflicting sources for the
same data.

## Backend (FastAPI + SQLite)

Location: `backend/`

- **Stack**: Python 3.11+, FastAPI, Uvicorn, stdlib `sqlite3`. No external DB
  server.
- **Migrations**: `backend/app/migrations.py` — idempotent, tracked in
  `_migrations` table. Applied on startup.
- **Routes**: `backend/app/routes.py` (projects, conversations, messages,
  providers, settings) + `backend/app/workspace_routes.py` (file operations).
- **Security**:
  - API keys stored in `backend/.env` only; never returned to the browser
    (`hasApiKey` boolean is the only signal exposed).
  - Workspace paths validated and confined to `WORKSPACE_ROOT` — traversal
    attempts are rejected.
  - CORS locked to `FRONTEND_ORIGIN`.
  - Destructive file operations require an explicit `confirm` / `overwrite`
    flag.
  - No arbitrary command execution is exposed in this phase.

## AI provider layer

`src/services/providers/aiProvider.ts` defines the `AIProvider` interface
(`isReady`, `stream`). Concrete adapters are registered per provider id. In
this phase, `stubProvider.ts` provides a safe no-op implementation that:
- never makes network calls,
- never reads or transmits API keys,
- reports `isReady() === false`.

Future phases swap the stub for real adapters (e.g. `GeminiAdapter`) without
touching callers. Provider routing is always proxied through the backend so
keys stay server-side.

## Error handling

- The HTTP client normalizes network, timeout, and HTTP errors into a single
  `ApiError` shape (`code`, `message`, `status`).
- Repository methods return `ApiResult<T>` envelopes (in-memory) or throw
  normalized errors (backend) so the UI can render consistent loading / success
  / empty / error states.
- Error responses never include stack traces or secrets.

## Security posture

| Concern                        | Mitigation                                                |
|--------------------------------|------------------------------------------------------------|
| API key exposure               | Keys live only in `backend/.env`; browser sees `hasApiKey`.|
| Path traversal                 | `safe_resolve()` confines all paths to `WORKSPACE_ROOT`.   |
| Arbitrary command execution    | Not exposed. No terminal route in this phase.              |
| CORS                           | Locked to `FRONTEND_ORIGIN`.                               |
| Destructive file ops           | Require explicit `confirm`/`overwrite` flags.              |
| Logging secrets                | Backend never logs API keys or file contents.              |

## Performance & resource budget

- No local model loading — all AI calls are remote (via backend proxy).
- No heavy frontend dependencies added in this stage.
- Repository calls are async and kept out of the render hot path.
- SQLite uses WAL journaling for low-contention local access.

## What is operational vs. scaffolded

**Operational now:**
- Repository contracts + in-memory implementation (localStorage persistence).
- HTTP client with timeout and error normalization.
- Backend FastAPI app with SQLite migrations, repositories, and routes for
  projects, conversations, messages, providers, settings, and workspace files.
- Provider adapter contract + safe stub.
- Workspace service with path validation.
- Config layer + `.env.example` + `.gitignore` hardening.

**Scaffolded for future stages:**
- Real AI provider adapters (Gemini, Groq, Cerebras, OpenRouter).
- Agent execution loop, terminal execution, memory/RAG layer.
- Auth, sharing, billing — intentionally not started.

## Phase 9 — On-disk workspace & project context

Phase 9 adds real filesystem access for imported projects, integrated into the
existing FastAPI backend. The frontend never touches the filesystem directly —
all operations go through validated backend routes.

### Workspace storage

- **Migration 0004** adds `workspace_path`, `import_source`, and
  `last_opened_at` columns to `projects`, plus a `recent_projects` table.
- Each imported project lives in its own directory under `WORKSPACE_ROOT`.
- `app/filesystem.py` is the centralized security service: path validation,
  symlink-escape detection, drive/UNC rejection, file-size/count limits, and
  the excluded-directory set shared by search and Agent context.
- `app/workspace_routes.py` exposes: lazy tree listing, file CRUD, directory
  creation, rename, filename/content search, ZIP import, empty-project
  creation, recent-projects list, and destructive on-disk deletion.
- `app/agent_file_tools.py` provides read-only project-context retrieval for
  the Agent, with secret-file exclusion and bounded character budgets.

### Security posture (Phase 9 additions)

| Concern                        | Mitigation                                                |
|--------------------------------|------------------------------------------------------------|
| ZIP Slip                       | `_validate_zip_entry` rejects `..`, absolute, drive, UNC.  |
| Symlink escape                 | `safe_resolve_in_project` resolves each component and      |
|                                | rejects links pointing outside the project root.           |
| Archive bombs                  | `MAX_ARCHIVE_BYTES`, `MAX_EXTRACTED_BYTES`,                |
|                                | `MAX_EXTRACTED_FILES`, `MAX_SINGLE_FILE_BYTES` enforced.   |
| Partial extraction cleanup     | `shutil.rmtree` on any failure during import.              |
| Project-root deletion          | `delete_path` and `delete_project_files` refuse to remove  |
|                                | the project root or workspace root.                        |
| Secret files in Agent context  | `SECRET_FILE_PATTERNS` skips `.env`, credentials, keys,    |
|                                | `.pem` files from broad searches and context collection.   |
| Project isolation              | Every file operation resolves the project root from the DB |
|                                | record; Agent context uses only the active project's root. |

### Test coverage (Phase 9)

Backend tests run with `pytest` from `backend/`:

| File | Tests | Coverage |
|------|-------|----------|
| `tests/test_filesystem.py` | 22 | Path validation, traversal, symlink escape/allow, file-size limits, excluded dirs |
| `tests/test_zip_import.py` | 11 | ZIP Slip, absolute/drive entries, archive limits, cleanup on failure, happy paths |
| `tests/test_workspace_routes.py` | 18 | File CRUD, confirm guards, directory ops, rename, tree, search, project isolation, persist-after-restart |
| `tests/test_agent_file_tools.py` | 18 | Secret exclusion, excluded dirs, context scoping, budget bounds, reference framing |

Frontend tests run with `vitest`:

| File | Tests | Coverage |
|------|-------|----------|
| `src/services/workspace.test.ts` | 20 | Path sanitization, confirm guards, request construction, error handling |
| `src/services/agentBackendProjectContext.test.ts` | 4 | projectId forwarding, retrieval bounds, error mapping |

All tests use temporary directories and isolated SQLite databases — no test
ever touches a real user project directory.

### What still needs manual Windows verification

- Symlink behavior on NTFS/junctions differs from POSIX and is skipped on
  Windows in the test suite.
- ZIP import of real-world large archives (near the 256 MB limit) should be
  smoke-tested on the target machine.
- End-to-end editor round-trip (open → edit → save → reopen) through a running
  FastAPI backend on Windows.

## Bolt preview vs. local execution

The Bolt preview environment does not run the Python backend. The frontend
detects this (`backendEnabled === false`) and runs in browser fallback mode.
On a real Windows machine, the user runs `backend/` locally and sets
`VITE_API_BASE_URL` to enable full persistence and file access. See
`docs/local-development.md`.
