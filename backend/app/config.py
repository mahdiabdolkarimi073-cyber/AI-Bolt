"""Application configuration loaded from environment variables."""
from __future__ import annotations

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

    # Provider API keys — never exposed to the browser.
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
