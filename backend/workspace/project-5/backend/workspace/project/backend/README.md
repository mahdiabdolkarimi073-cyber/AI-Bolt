# Personal AI IDE — Local Backend (FastAPI + SQLite)

This is the local backend service for the Personal AI IDE. It is **optional**
in the current Bolt preview environment: when `VITE_API_BASE_URL` is unset, the
frontend runs in a self-contained browser fallback mode (localStorage-backed).

On a real Windows / local dev machine, you run this service to get real
persistence (SQLite), workspace file access, and provider proxying.

## Stack
- Python 3.11+
- FastAPI + Uvicorn
- SQLite (via `sqlite3` stdlib — no server to install)

## Setup (local machine)

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
pip install -r requirements.txt
cp .env.example .env             # add your provider API keys here
python -m app.main               # serves http://localhost:8000
```

Then set `VITE_API_BASE_URL=http://localhost:8000` in the project root `.env`
and restart the frontend dev server.

## Security
- API keys live only in `backend/.env` on the local machine. They are never
  sent to the browser and never logged.
- All workspace file operations are validated and confined to an approved
  workspace root (`WORKSPACE_ROOT`).
- No arbitrary command execution is exposed by this service in this phase.
- CORS is locked to the configured frontend origin.

See `docs/architecture.md` and `docs/local-development.md` for full details.
