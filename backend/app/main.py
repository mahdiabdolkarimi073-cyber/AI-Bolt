"""FastAPI application entrypoint.

Run locally with:
    python -m app.main
or:
    uvicorn app.main:app --reload
"""
from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.logging_config import configure_logging
from app.db import connect, run_migrations
from app.devkey import ensure_dev_key, EncryptionKeyError
from app.routes import register_routes
from app.workspace_routes import router as workspace_router
from app.agent_routes import router as agent_router
from app.agent_stream_routes import router as agent_stream_router
from app.connection_routes import router as connection_router
from app.memory_routes import router as memory_router, kb_router as knowledge_router
from app.terminal_routes import router as terminal_router
from app.snapshot_routes import router as snapshot_router
from app.diagnostics_routes import router as diagnostics_router
from app.preview_routes import router as preview_router, init_preview_table
from app.execution import mark_stale_sessions_stopped, process_manager


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Configure structured terminal logging before anything else runs.
    configure_logging()
    # Ensure credential encryption is available before any route can run.
    # In production this raises if PAIDE_ENC_KEY is missing; in development it
    # auto-provisions a stable key in backend/.env.dev on first startup.
    try:
        ensure_dev_key()
    except EncryptionKeyError as exc:
        raise RuntimeError(f"Startup blocked — encryption key not available: {exc}") from exc
    # Run migrations on startup.
    conn = connect()
    try:
        run_migrations(conn)
    finally:
        conn.close()
    # Mark any orphaned sessions from a previous run as stopped.
    mark_stale_sessions_stopped()
    # Initialize preview sessions tracking table.
    init_preview_table()
    yield
    # On shutdown, terminate any still-running processes.
    process_manager.cleanup_all()


app = FastAPI(
    title="Personal AI IDE — Local Backend",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_origin],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Request-Id"],
)

register_routes(app)
app.include_router(workspace_router)
app.include_router(agent_router)
app.include_router(agent_stream_router)
app.include_router(connection_router)
app.include_router(memory_router)
app.include_router(knowledge_router)
app.include_router(terminal_router)
app.include_router(snapshot_router)
app.include_router(diagnostics_router)
app.include_router(preview_router)


@app.get("/health", tags=["system"])
def health():
    return {"status": "ok", "version": "0.1.0"}


def main():
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=False,
    )


if __name__ == "__main__":
    main()
