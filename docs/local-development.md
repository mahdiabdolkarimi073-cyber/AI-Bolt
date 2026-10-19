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

## Limitations in this stage

- AI providers are stubbed (no real completions yet).
- No terminal execution, agent loop, or RAG memory layer.
- No authentication or multi-user support.
- The Bolt preview runs in fallback mode only.
