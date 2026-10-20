"""Structured terminal logging for the Personal AI IDE backend.

Configures the ``app`` logger hierarchy so that log lines are written to the
VS Code / PowerShell terminal (stdout) with consistent prefixes and are flushed
immediately (stream is unbuffered). Verbose DEBUG logs are gated behind the
``PAIDE_DEBUG_LOG`` environment variable so warnings/errors remain visible by
default without flooding the terminal.

Prefixes used across the backend:
  [AI-IDE][BACKEND]   — request lifecycle, model resolution, persistence
  [AI-IDE][PROVIDER]  — adapter calls, provider metadata, retries
  [AI-IDE][ERROR]     — failures and exception tracebacks

Security: this module never logs API keys, authorization headers, access
tokens, passwords, or encryption keys. Callers are responsible for sanitizing
values before passing them to the logger helpers.
"""
from __future__ import annotations

import logging
import os
import sys
from typing import Optional

_PREFIX_BACKEND = "[AI-IDE][BACKEND]"
_PREFIX_PROVIDER = "[AI-IDE][PROVIDER]"
_PREFIX_ERROR = "[AI-IDE][ERROR]"

_LOGGER_NAME = "app"

_configured = False


def configure_logging() -> None:
    """Configure root ``app`` logger to emit to stdout with structured prefixes.

    Idempotent — safe to call multiple times. Sets an unbuffered stream handler
    so logs appear in the terminal while requests are running.
    """
    global _configured
    if _configured:
        return

    debug_enabled = _debug_enabled()
    level = logging.DEBUG if debug_enabled else logging.INFO

    logger = logging.getLogger(_LOGGER_NAME)
    logger.setLevel(level)
    # Avoid duplicate handlers if the root logger already has one.
    logger.propagate = False

    handler = logging.StreamHandler(sys.stdout)
    handler.setLevel(level)
    # Use a minimal formatter — the prefix is added by the helper functions so
    # structured fields remain easy to grep in the terminal.
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%H:%M:%S"))
    # Ensure logs are flushed promptly.
    handler.stream = _UnbufferedStream(sys.stdout)
    logger.addHandler(handler)

    _configured = True


class _UnbufferedStream:
    """Wrapper that flushes after every write so logs appear immediately."""

    def __init__(self, stream) -> None:
        self._stream = stream

    def write(self, data: str) -> int:
        n = self._stream.write(data)
        self._stream.flush()
        return n

    def flush(self) -> None:
        self._stream.flush()

    def __getattr__(self, name: str):
        return getattr(self._stream, name)


def _debug_enabled() -> bool:
    raw = os.environ.get("PAIDE_DEBUG_LOG", "")
    return raw.strip().lower() in ("1", "true", "yes", "on")


def is_debug_enabled() -> bool:
    return _debug_enabled()


def _logger() -> logging.Logger:
    configure_logging()
    return logging.getLogger(_LOGGER_NAME)


# --- Public helpers ---------------------------------------------------------


def log_backend(message: str, *, level: int = logging.INFO, **fields) -> None:
    """Emit a [AI-IDE][BACKEND] line with optional structured fields."""
    _logger().log(level, "%s %s%s", _PREFIX_BACKEND, message, _format_fields(fields))


def log_provider(message: str, *, level: int = logging.INFO, **fields) -> None:
    """Emit a [AI-IDE][PROVIDER] line with optional structured fields."""
    _logger().log(level, "%s %s%s", _PREFIX_PROVIDER, message, _format_fields(fields))


def log_error(message: str, *, exc: Optional[BaseException] = None, **fields) -> None:
    """Emit a [AI-IDE][ERROR] line. When ``exc`` is supplied and DEBUG is
    enabled, the full traceback is printed; otherwise only the sanitized
    one-line message is shown."""
    _logger().error("%s %s%s", _PREFIX_ERROR, message, _format_fields(fields))
    if exc is not None and is_debug_enabled():
        _logger().debug("%s %s", _PREFIX_ERROR, _format_traceback(exc))


def _format_fields(fields: dict) -> str:
    if not fields:
        return ""
    parts = []
    for key, value in fields.items():
        parts.append(f"{key}={_safe_value(value)}")
    return " " + " ".join(parts)


def _safe_value(value) -> str:
    if value is None:
        return "(none)"
    if isinstance(value, str):
        return value if value else "(empty)"
    if isinstance(value, (int, float, bool)):
        return str(value)
    return str(value)


def _format_traceback(exc: BaseException) -> str:
    import traceback as _tb

    return "".join(_tb.format_exception(type(exc), exc, exc.__traceback__))
