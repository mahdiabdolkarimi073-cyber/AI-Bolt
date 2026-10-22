"""Tests for automatic development encryption-key provisioning.

Covers: first startup (key created), subsequent restart (same key reused),
saving+retrieving a credential through the repository, and the production
case where an explicit key is required.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import Iterator

import pytest
from cryptography.fernet import Fernet


@pytest.fixture
def isolated_backend_env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """Point the config module at a temporary backend root with no .env files.

    Each test gets a clean directory used as BACKEND_ROOT, with no PAIDE_ENC_KEY
    anywhere. Yields the temp backend root.
    """
    backend_root = tmp_path / "backend"
    backend_root.mkdir(parents=True, exist_ok=True)
    (backend_root / "app").mkdir(parents=True, exist_ok=True)

    monkeypatch.delenv("PAIDE_ENC_KEY", raising=False)
    monkeypatch.delenv("PAIDE_ENV", raising=False)
    monkeypatch.delenv("PAIDE_ALLOW_DEV_KEY", raising=False)

    from app import config as _config
    monkeypatch.setattr(_config, "BACKEND_ROOT", backend_root, raising=True)
    monkeypatch.setattr(_config, "ENV_FILE", backend_root / ".env", raising=True)
    monkeypatch.setattr(_config, "DEV_ENV_FILE", backend_root / ".env.dev", raising=True)

    # Also point the devkey module's imported references at the temp paths.
    from app import devkey as _devkey
    monkeypatch.setattr(_devkey, "BACKEND_ROOT", backend_root, raising=True)
    monkeypatch.setattr(_devkey, "ENV_FILE", backend_root / ".env", raising=True)
    monkeypatch.setattr(_devkey, "DEV_ENV_FILE", backend_root / ".env.dev", raising=True)

    _config.settings = _config.Settings(_env_file=backend_root / ".env")
    yield backend_root
    monkeypatch.delenv("PAIDE_ENC_KEY", raising=False)


def _reload_crypto():
    # Force crypto to re-read the key on next call.
    from app import crypto as _crypto
    return _crypto


class TestFirstStartup:
    def test_creates_dev_key_when_none_configured(self, isolated_backend_env: Path):
        from app.devkey import ensure_dev_key
        source = ensure_dev_key()
        assert source == "dev-file-created"
        dev_file = isolated_backend_env / ".env.dev"
        assert dev_file.exists()
        content = dev_file.read_text(encoding="utf-8")
        assert "PAIDE_ENC_KEY=" in content
        key = os.environ.get("PAIDE_ENC_KEY")
        assert key is not None and len(key) > 20
        # The persisted value must match what was activated.
        assert key in content
        # And it must be a valid Fernet key.
        Fernet(key.encode("utf-8"))

    def test_encryption_becomes_available_after_provisioning(self, isolated_backend_env: Path):
        from app.devkey import ensure_dev_key
        from app.crypto import is_encryption_available
        assert not is_encryption_available()
        ensure_dev_key()
        assert is_encryption_available()


class TestSubsequentRestart:
    def test_reuses_existing_dev_key_across_calls(self, isolated_backend_env: Path):
        from app.devkey import ensure_dev_key
        first = ensure_dev_key()
        assert first == "dev-file-created"
        first_key = os.environ.get("PAIDE_ENC_KEY")
        # Simulate a restart: clear the in-process env, keep the file on disk.
        os.environ.pop("PAIDE_ENC_KEY", None)
        from app import config as _config
        _config.settings = _config.Settings(_env_file=isolated_backend_env / ".env")
        second = ensure_dev_key()
        assert second == "dev-file-existing"
        second_key = os.environ.get("PAIDE_ENC_KEY")
        assert second_key == first_key, "restart must reuse the same key"

    def test_does_not_overwrite_existing_dev_file(self, isolated_backend_env: Path):
        from app.devkey import ensure_dev_key
        ensure_dev_key()
        dev_file = isolated_backend_env / ".env.dev"
        before = dev_file.read_text(encoding="utf-8")
        os.environ.pop("PAIDE_ENC_KEY", None)
        from app import config as _config
        _config.settings = _config.Settings(_env_file=isolated_backend_env / ".env")
        ensure_dev_key()
        after = dev_file.read_text(encoding="utf-8")
        assert before == after


class TestSaveAndRetrieveCredential:
    def test_encrypt_then_decrypt_round_trip(self, isolated_backend_env: Path):
        from app.devkey import ensure_dev_key
        from app.crypto import encrypt, decrypt
        ensure_dev_key()
        token = encrypt("AIza-super-secret-gemini-key-12345")
        assert token != "AIza-super-secret-gemini-key-12345"
        assert decrypt(token) == "AIza-super-secret-gemini-key-12345"

    def test_existing_credential_remains_readable_after_restart(self, isolated_backend_env: Path):
        from app.devkey import ensure_dev_key
        from app.crypto import encrypt, decrypt
        ensure_dev_key()
        token = encrypt("AIza-secret-key-abc")
        # Simulate restart: drop in-memory key, reload from dev file.
        os.environ.pop("PAIDE_ENC_KEY", None)
        from app import config as _config
        _config.settings = _config.Settings(_env_file=isolated_backend_env / ".env")
        ensure_dev_key()
        assert decrypt(token) == "AIza-secret-key-abc"


class TestExplicitKeyHonored:
    def test_env_var_key_is_used_and_dev_file_not_created(self, isolated_backend_env: Path, monkeypatch: pytest.MonkeyPatch):
        explicit = Fernet.generate_key().decode("utf-8")
        monkeypatch.setenv("PAIDE_ENC_KEY", explicit)
        from app.devkey import ensure_dev_key
        source = ensure_dev_key()
        assert source == "environment"
        assert not (isolated_backend_env / ".env.dev").exists()
        from app.crypto import decrypt, encrypt
        assert decrypt(encrypt("hello")) == "hello"

    def test_env_file_key_is_used_and_dev_file_not_created(self, isolated_backend_env: Path):
        explicit = Fernet.generate_key().decode("utf-8")
        env_path = isolated_backend_env / ".env"
        env_path.write_text(f"PAIDE_ENC_KEY={explicit}\n", encoding="utf-8")
        from app import config as _config
        _config.settings = _config.Settings(_env_file=env_path)
        from app.devkey import ensure_dev_key
        source = ensure_dev_key()
        assert source == "env-file", source
        assert not (isolated_backend_env / ".env.dev").exists()


class TestProductionRequiresExplicitKey:
    def test_production_raises_when_no_key(self, isolated_backend_env: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("PAIDE_ENV", "production")
        from app import config as _config
        _config.settings = _config.Settings(_env_file=isolated_backend_env / ".env")
        from app.devkey import ensure_dev_key, EncryptionKeyError
        with pytest.raises(EncryptionKeyError) as exc:
            ensure_dev_key()
        assert "PAIDE_ENC_KEY" in str(exc.value)
        assert not (isolated_backend_env / ".env.dev").exists()

    def test_production_accepts_explicit_key(self, isolated_backend_env: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("PAIDE_ENV", "production")
        explicit = Fernet.generate_key().decode("utf-8")
        monkeypatch.setenv("PAIDE_ENC_KEY", explicit)
        from app import config as _config
        _config.settings = _config.Settings(_env_file=isolated_backend_env / ".env")
        from app.devkey import ensure_dev_key
        assert ensure_dev_key() == "environment"

    def test_dev_key_disabled_raises(self, isolated_backend_env: Path, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv("PAIDE_ALLOW_DEV_KEY", "false")
        from app import config as _config
        _config.settings = _config.Settings(_env_file=isolated_backend_env / ".env")
        from app.devkey import ensure_dev_key, EncryptionKeyError
        with pytest.raises(EncryptionKeyError):
            ensure_dev_key()
