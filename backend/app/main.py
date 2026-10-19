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
from app.db import connect, run_migrations
from app.routes import register_routes
from app.workspace_routes import router as workspace_router
from app.agent_routes import router as agent_router
from app.connection_routes import router as connection_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Run migrations on startup.
    conn = connect()
    try:
        run_migrations(conn)
    finally:
        conn.close()
    yield


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
    allow_headers=["Content-Type", "Authorization"],
)

register_routes(app)
app.include_router(workspace_router)
app.include_router(agent_router)
app.include_router(connection_router)


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
