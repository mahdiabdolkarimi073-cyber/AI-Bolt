# Local Development Guide

This guide explains how to run the Personal AI IDE on your local machine
(Windows or otherwise) with the real FastAPI + SQLite backend.

## Prerequisites

- Node.js 18+ and npm
- Python 3.11+
- ~8 GB RAM (no GPU required)

## 1. Frontend

```bash
npm install
npm run dev          # http://localhost:5173
```

By default the frontend runs in **browser fallback mode** (localStorage
persistence, no backend). This is enough to explore the UI.

## 2. Backend (optional, for real persistence + file access)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows PowerShell / cmd
# On macOS/Linux: source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
# Edit backend/.env: set WORKSPACE_ROOT to a folder where your projects live.
python -m app.main              # serves http://localhost:8000
```

## 3. Connect frontend to backend

In the **project root** (not `backend/`), create or edit `.env`:

```env
VITE_API_BASE_URL=http://localhost:8000
```

Restart `npm run dev`. The frontend now uses the backend for all persistence
and workspace operations. SQLite is created at `backend/data/paide.db`
automatically on first run.

## Environment variables reference

### Frontend (project root `.env`)

| Variable               | Required | Default   | Description                          |
|------------------------|----------|-----------|--------------------------------------|
| `VITE_API_BASE_URL`    | no       | (empty)   | Backend URL. Empty = fallback mode.  |
| `VITE_DEFAULT_PROVIDER`| no       | `gemini`  | Initial active provider id.          |

### Backend (`backend/.env`)

| Variable          | Required | Default                | Description                              |
|-------------------|----------|------------------------|------------------------------------------|
| `WORKSPACE_ROOT`  | yes      | `./workspace`          | Root folder for all project files.       |
| `DATABASE_URL`    | no       | `sqlite:///./data/...` | SQLite path.                             |
| `FRONTEND_ORIGIN` | no       | `http://localhost:5173`| Allowed CORS origin.                     |
| `HOST`            | no       | `127.0.0.1`            | Bind address.                            |
| `PORT`            | no       | `8000`                 | Backend port.                            |
| `*_API_KEY`       | no       | (empty)                | Provider keys; never sent to browser.    |

## Security checklist for local use

- Keep `backend/.env` out of version control (it is gitignored).
- Set `WORKSPACE_ROOT` to a dedicated folder, not your entire home directory.
- Do not commit the SQLite database (`backend/data/` is gitignored).
- API keys are read by the backend only; the frontend never sees them.

## Verification

- `npm run build` and `npm run typecheck` should pass.
- `curl http://localhost:8000/health` → `{"status":"ok"}`.
- Open the app; create a project via the dialog — it should persist across
  page reloads (backend mode) or browser restarts (fallback mode).

## Phase 10 — Terminal, execution & runtime detection

Phase 10 adds real local process execution, live output streaming over
WebSocket, framework/runtime detection, and AI-assisted error diagnosis.

### Terminal usage

Open the terminal panel in the IDE bottom dock. Commands run as real
operating-system processes on your machine:

- **Finite commands** (echo, build, test, lint) run with a 120 s default
  timeout. Output streams live into the panel.
- **Long-running dev servers** (`npm run dev`, `php artisan serve`, etc.)
  are marked `longRunning` and get a 6-hour cap. A preview URL is detected
  automatically from stdout (e.g. `http://localhost:5173/`) and shown as a
  clickable link when the server prints it.
- **Stop** terminates the process and its children (process-group SIGTERM
  → SIGKILL on POSIX; `proc.terminate` → `proc.kill` on Windows).

### Windows PowerShell / CMD requirements

The backend auto-detects the shell:

- **Windows**: prefers PowerShell Core (`pwsh`), then Windows PowerShell
  (`powershell`), falling back to `cmd.exe`. PowerShell is invoked with
  `-NoProfile -NonInteractive -Command`; cmd with `/C`.
- **POSIX**: uses `$SHELL`, then `/bin/bash`, then `/bin/sh` with `-c`.

If you run the backend as **Administrator** on Windows, a warning is
logged; on POSIX the backend refuses to execute as root (`geteuid() == 0`)
and returns HTTP 403 for any `/exec/sessions` request.

### Runtime prerequisites

Runtime detection reads real manifest files (`package.json`,
`pyproject.toml`, `requirements.txt`, `composer.json`, `artisan`) and
probes `PATH` for installed tools (`node`, `npm`, `pnpm`, `yarn`, `bun`,
`python`, `pip`, `poetry`, `uv`, `pytest`, `php`, `composer`). Detected
frameworks: Vite, Next.js, NestJS, Express, React, Poetry, uv, Laravel.

When a tool is missing, the IDE reports it honestly and shows an install
hint (without running any install command). Inferred commands respect the
project's existing `scripts` and the lockfile-implied package manager.

### Execution security

This is **not** an OS-level sandbox. The trust model is documented in
`backend/app/execution.py`:

- Backend binds to `127.0.0.1` only — no remote exposure.
- Working directories are validated against the registered project root;
  absolute paths and `..` traversal are rejected.
- AI-proposed commands (`source: ai_proposed`) and dependency installs
  (`kind: deps`) always require explicit `approved: true` from the UI.
- Output is secret-redacted (OpenAI/Google/Slack keys, JWTs, `key=value`
  patterns) before streaming or storage.
- Concurrency (max 8 sessions), per-stream output (2 MB), and runtime
  limits are enforced.
- The AI diagnosis flow reads project files, asks the configured provider
  to propose fixes, shows a reviewable diff, and only writes through the
  workspace file service after the user selects and approves changes.
  Re-running the failed command requires a separate button click.

### Manual verification steps

1. Start the backend (`python -m app.main`) and frontend (`npm run dev`).
2. Import or create a project with a `package.json`.
3. Open the terminal; the runtime panel should show `node` + the detected
   framework and inferred `dev`/`build`/`test` commands.
4. Run `echo hello` — it should complete with exit 0 and show the output.
5. Run a failing command (`sh -c 'exit 7'`) — it should show exit code 7.
6. Start `npm run dev` (or `python3 -m http.server`) as a long-running
   server; confirm the preview URL appears and Stop terminates it.
7. Trigger AI error diagnosis on a failed session; review the proposed
   diff, apply selected changes, and re-run the command.

### Limitations in this stage

- No OS-level process sandboxing; isolation relies on the local-only bind
  and project-root working-directory validation.
- No authentication or multi-user support.
- Real provider round-trips for AI diagnosis require a configured
  connection + `PAIDE_ENC_KEY`; without them, a simulation fallback is
  available when `allowSimulation: true`.
