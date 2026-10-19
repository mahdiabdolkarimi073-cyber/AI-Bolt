"""Application configuration loaded from environment variables."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Optional

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
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


settings = Settings()


def workspace_root_path() -> Path:
    p = Path(settings.workspace_root).resolve()
    p.mkdir(parents=True, exist_ok=True)
    return p


def db_path() -> Path:
    # Convert "sqlite:///./data/paide.db" -> ./data/paide.db
    url = settings.database_url
    if url.startswith("sqlite:///"):
        rel = url[len("sqlite:///"):]
    else:
        rel = "./data/paide.db"
    p = Path(rel).resolve()
    p.parent.mkdir(parents=True, exist_ok=True)
    return p


def local_endpoint_allowlist() -> set[str]:
    return {h.strip() for h in settings.local_endpoint_hosts.split(",") if h.strip()}


def is_encryption_configured() -> bool:
    return bool(os.environ.get("PAIDE_ENC_KEY")) or settings.paide_enc_key is not None
