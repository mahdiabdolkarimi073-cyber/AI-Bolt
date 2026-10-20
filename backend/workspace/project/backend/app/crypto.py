"""Authenticated encryption at rest for stored API credentials.

Uses the `cryptography` library (Fernet, AES-128-CBC + HMAC-SHA256). The master
key is supplied through the `PAIDE_ENC_KEY` environment variable (or
backend/.env) and is NEVER stored beside the encrypted credentials in SQLite.

Key generation:
    python -m app.crypto generate-key

This prints a fresh Fernet key. Put it in backend/.env as:
    PAIDE_ENC_KEY=<printed key>

Requirements:
    - The key must be a valid URL-safe base64 32-byte key (Fernet format).
    - If the key is missing or invalid, credential reads/writes fail safe:
      encryption returns False, decryption raises EncryptionError.
    - Never commit the master key. Never put it in .env.example.
    - If the master key is lost, encrypted credentials CANNOT be recovered.
      Documented backup/recovery implications in docs/provider-management.md.
"""
from __future__ import annotations

import sys
from typing import Optional

from cryptography.fernet import Fernet, InvalidToken


class EncryptionError(Exception):
    """Raised when credentials cannot be encrypted or decrypted safely."""


def _get_key() -> Optional[bytes]:
    """Load the master key from the environment. Returns None if unset/invalid."""
    import os

    raw = os.environ.get("PAIDE_ENC_KEY")
    if not raw:
        return None
    try:
        return raw.encode("utf-8")
    except Exception:
        return None


def _fernet() -> Optional[Fernet]:
    key = _get_key()
    if not key:
        return None
    try:
        return Fernet(key)
    except Exception:
        # Invalid key format — fail safe.
        return None


def is_encryption_available() -> bool:
    """True when a valid master key is configured and ready to use."""
    return _fernet() is not None


def encrypt(plaintext: str) -> str:
    """Encrypt a plaintext credential. Returns a Fernet token as a string.

    Raises EncryptionError if encryption is not available or fails. Never
    returns plaintext.
    """
    f = _fernet()
    if f is None:
        raise EncryptionError(
            "Credential encryption is not available. Set PAIDE_ENC_KEY "
            "(generate one with: python -m app.crypto generate-key)."
        )
    if not isinstance(plaintext, str) or not plaintext:
        raise EncryptionError("Cannot encrypt an empty credential.")
    try:
        return f.encrypt(plaintext.encode("utf-8")).decode("utf-8")
    except Exception as exc:
        raise EncryptionError("Encryption failed.") from exc


def decrypt(token: str) -> str:
    """Decrypt a Fernet token back to plaintext.

    Raises EncryptionError if the key is missing, the token is invalid, or the
    key does not match the one used to encrypt. Never returns partial data.
    """
    f = _fernet()
    if f is None:
        raise EncryptionError(
            "Credential decryption is not available. PAIDE_ENC_KEY is not set."
        )
    if not isinstance(token, str) or not token:
        raise EncryptionError("Cannot decrypt an empty token.")
    try:
        return f.decrypt(token.encode("utf-8")).decode("utf-8")
    except InvalidToken as exc:
        raise EncryptionError(
            "Credential could not be decrypted. The master key may be wrong "
            "or the credential is corrupted."
        ) from exc
    except Exception as exc:
        raise EncryptionError("Decryption failed.") from exc


def mask_key(key: str) -> str:
    """Return a masked representation of an API key for safe display.

    Never reveals the full key. Shows the first 4 and last 4 characters when
    the key is long enough; otherwise shows only a fixed-length mask.
    """
    if not isinstance(key, str) or not key:
        return ""
    if len(key) <= 12:
        return "••••••••"
    return f"{key[:4]}••••••••{key[-4:]}"


def main() -> int:
    """CLI entrypoint: generate a new Fernet master key."""
    if len(sys.argv) > 1 and sys.argv[1] == "generate-key":
        print(Fernet.generate_key().decode("utf-8"))
        return 0
    print("Usage: python -m app.crypto generate-key", file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
