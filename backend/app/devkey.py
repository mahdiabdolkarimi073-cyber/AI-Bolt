"""Automatic development encryption-key provisioning.

Problem this solves: on a fresh local checkout, PAIDE_ENC_KEY is unset, so
saving any API key fails with "Credential encryption is not configured".
Requiring the user to run `python -m app.crypto generate-key` and paste the
result into backend/.env is a poor local-dev experience.

Behavior:
- Production (PAIDE_ENV=production): NEVER auto-provisions. If
  PAIDE_ENC_KEY is missing, raise EncryptionKeyError with an actionable
  message. Existing explicit keys are always honored.
- Development (default): if no usable key is already configured
  (os.environ, backend/.env, or an existing backend/.env.dev), generate a
  fresh Fernet key ONCE, persist it to backend/.env.dev, and load it into
  os.environ and Settings. On subsequent startups the same key is reused,
  so previously encrypted credentials remain readable.
- Never overwrites an existing key in backend/.env, backend/.env.dev, or
  os.environ. Never stores plaintext API keys.

backend/.env.dev is a local-only file (gitignored) distinct from backend/.env
so user edits to .env are not clobbered.
"""
from __future__ import annotations

import os
from pathlib import Path

from cryptography.fernet import Fernet

from app.config import (
    BACKEND_ROOT,
    DEV_ENV_FILE,
    ENV_FILE,
    is_production,
    reload_settings,
)


class EncryptionKeyError(RuntimeError):
    """Raised when encryption key provisioning fails or is required but missing."""


def _read_env_value(path: Path, key: str) -> str | None:
    if not path.exists():
        return None
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        if k.strip() == key:
            return v.strip()
    return None


def _append_env_pair(path: Path, key: str, value: str) -> None:
    """Append `key=value` to a .env-style file, creating it if needed."""
    body = path.read_text(encoding="utf-8") if path.exists() else ""
    suffix = "" if (body and body.endswith("\n")) else ("\n" if body else "")
    path.write_text(body + suffix + f"{key}={value}\n", encoding="utf-8")


def _has_usable_key() -> bool:
    from app.crypto import is_encryption_available

    return is_encryption_available()


def ensure_dev_key() -> str:
    """Ensure a usable encryption key is available.

    Returns the key source description (for logging): one of
    "environment", "env-file", "dev-file-existing", "dev-file-created".

    Raises EncryptionKeyError if production is set and no key is configured,
    or if a new dev key could not be written.
    """
    if _has_usable_key():
        if os.environ.get("PAIDE_ENC_KEY"):
            return "environment"
        if ENV_FILE.exists() and _read_env_value(ENV_FILE, "PAIDE_ENC_KEY"):
            return "env-file"
        return "dev-file-existing"

    if is_production():
        raise EncryptionKeyError(
            "PAIDE_ENC_KEY is not configured. Production requires an explicitly "
            "configured encryption key. Generate one with "
            "`python -m app.crypto generate-key` and set PAIDE_ENC_KEY in "
            "backend/.env."
        )

    if not _dev_key_allowed():
        raise EncryptionKeyError(
            "PAIDE_ENC_KEY is not configured and automatic development key "
            "provisioning is disabled (PAIDE_ALLOW_DEV_KEY=false). Generate "
            "one with `python -m app.crypto generate-key` and set it in "
            "backend/.env."
        )

    # Reuse an existing dev key on disk if present (keeps stored creds readable).
    existing = _read_env_value(DEV_ENV_FILE, "PAIDE_ENC_KEY")
    if existing:
        _activate_key(existing)
        return "dev-file-existing"

    new_key = Fernet.generate_key().decode("utf-8")
    try:
        DEV_ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
        _append_env_pair(DEV_ENV_FILE, "PAIDE_ENC_KEY", new_key)
    except OSError as exc:
        raise EncryptionKeyError(
            f"Could not write development encryption key to {DEV_ENV_FILE}: {exc}. "
            "Set PAIDE_ENC_KEY manually in backend/.env."
        ) from exc

    _activate_key(new_key)
    return "dev-file-created"


def _dev_key_allowed() -> bool:
    raw = os.environ.get("PAIDE_ALLOW_DEV_KEY")
    if raw is None:
        from app.config import settings

        return settings.allow_dev_key
    return raw.strip().lower() not in ("0", "false", "no", "off")


def _activate_key(key: str) -> None:
    """Make `key` visible to crypto._get_key() without rewriting backend/.env."""
    os.environ["PAIDE_ENC_KEY"] = key
    reload_settings()
