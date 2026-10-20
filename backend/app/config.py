"""Application configuration loaded from environment variables.

The .env file is always resolved relative to the backend/ package directory
(not the current working directory), so configuration loads consistently
whether the server is started from the repository root or from backend/.

A separate local-only file `backend/.env.dev` holds an auto-generated
development encryption key (see app.devkey). It is loaded after .env and never
committed.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/app/config.py -> backend/
BACKEND_ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = BACKEND_ROOT / ".env"
DEV_ENV_FILE = BACKEND_ROOT / ".env.dev"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
    )

    workspace_root: str = "./workspace"
    database_url: str = "sqlite:///./data/paide.db"
    frontend_origin: str = "http://localhost:5173"
    host: str = "127.0.0.1"
    port: int = 8000

    # Master encryption key for stored API credentials (Fernet). NEVER commit.
    # Generate with: python -m app.crypto generate-key
    paide_enc_key: Optional[str] = None

    # Allow plain HTTP for explicitly local development endpoints. Remote
    # providers must use HTTPS. Defaults to False for safety.
    allow_local_http: bool = False

    # Comma-separated allowlist of loopback hosts permitted for custom local
    # endpoints (e.g. "localhost,127.0.0.1"). Used by the SSRF guard.
    local_endpoint_hosts: str = "localhost,127.0.0.1,::1"

    # Legacy provider API keys (from backend/.env) — still supported for
    # backward compatibility. Never exposed to the browser.
    gemini_api_key: Optional[str] = None
    groq_api_key: Optional[str] = None
    cerebras_api_key: Optional[str] = None
    openrouter_api_key: Optional[str] = None

    # When true, the backend may auto-provision a development encryption key
    # (see app.devkey). Defaults to true for local dev; set PAIDE_ENV=production
    # to disable and require an explicitly configured key.
    allow_dev_key: bool = True
    env: str = "development"


settings = Settings()


def reload_settings() -> Settings:
    """Re-read settings from environment files. Used after dev-key init."""
    global settings
    settings = Settings()
    return settings


def workspace_root_path() -> Path:
    p = Path(settings.workspace_root).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    # DATABASE_URL is relative to backend/ (where .env lives), not to cwd.
    url = settings.database_url
    if url.startswith("sqlite:///"):
        rel = url[len("sqlite:///"):]
    else:
        rel = "./data/paide.db"
    # Resolve relative to BACKEND_ROOT so it is stable regardless of cwd.
    p = (BACKEND_ROOT / rel).resolve() if not os.path.isabs(rel) else Path(rel)
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def local_endpoint_allowlist() -> set[str]:
    return {h.strip() for h in settings.local_endpoint_hosts.split(",") if h.strip()}


def is_production() -> bool:
    """True when running in an explicit production environment.

    Production requires a deliberately configured PAIDE_ENC_KEY and never
    auto-provisions a development key. Controlled by PAIDE_ENV=production.
    """
    raw = os.environ.get("PAIDE_ENV")
    if raw is None:
        raw = settings.env
    return raw.strip().lower() == "production"


def is_encryption_configured() -> bool:
    return bool(os.environ.get("PAIDE_ENC_KEY")) or settings.paide_enc_key is not None
