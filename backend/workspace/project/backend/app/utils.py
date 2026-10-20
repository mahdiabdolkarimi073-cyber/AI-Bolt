"""Utilities: ID generation, JSON helpers, timestamps."""
from __future__ import annotations

import json
import secrets
import time
from typing import Any


def uid(prefix: str) -> str:
    return f"{prefix}-{int(time.time() * 1000):x}-{secrets.token_hex(3)}"


def now_ms() -> int:
    return int(time.time() * 1000)


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def loads(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None
