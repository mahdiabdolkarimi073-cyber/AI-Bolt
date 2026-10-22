"""Central port reservation for AI-Bolt preview servers.

AI-Bolt itself occupies ports 5173 (Vite frontend) and 8000 (FastAPI backend).
No project spawned by the Preview system may bind to these ports, regardless
of what the project's own configuration says.

This module is the single source of truth for reserved ports and free-port
allocation. Both the Preview routes and any Agent execution paths that start
dev servers must go through here.
"""
from __future__ import annotations

import socket
import threading
from typing import Optional

# Ports reserved for AI-Bolt itself.  These must never be assigned to a
# preview server, no matter what the project config or framework defaults to.
RESERVED_PORTS: frozenset[int] = frozenset({5173, 8000})

# Range of assignable ports for preview servers.
PORT_RANGE_START = 3000
PORT_RANGE_END = 65535

# Ports known to be commonly used by dev servers that we should skip to avoid
# surprising conflicts with other developer tools.
_SKIP_PORTS: frozenset[int] = frozenset({
    3000, 3001, 4000, 5000, 5001, 8080, 8888, 9000,
})

_lock = threading.Lock()
# Track ports we handed out to preview sessions so two concurrent starts don't
# race to the same free port between the check and the actual bind.
_assigned: dict[int, str] = {}  # port -> session_id


def _is_port_free(port: int) -> bool:
    """Return True if the TCP port is free on all local interfaces."""
    for family in (socket.AF_INET, socket.AF_INET6):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 0)
                s.bind(("127.0.0.1", port) if family == socket.AF_INET else ("::1", port))
        except OSError:
            return False
    return True


def is_reserved(port: int) -> bool:
    """Return True if the port is reserved for AI-Bolt and must not be used."""
    return port in RESERVED_PORTS


def allocate_port(session_id: str, preferred: Optional[int] = None) -> int:
    """Find and reserve a free, non-reserved port for a preview session.

    *preferred* — if given and available, try that port first.

    Raises RuntimeError if no suitable port is available.
    """
    with _lock:
        # Try preferred first.
        if preferred is not None:
            if preferred in RESERVED_PORTS:
                raise ReservedPortError(
                    f"Port {preferred} is reserved for AI-Bolt and cannot be used."
                )
            if preferred in _assigned:
                raise RuntimeError(f"Port {preferred} is already assigned to another preview.")
            if _is_port_free(preferred):
                _assigned[preferred] = session_id
                return preferred

        # Scan for a free port.
        for port in range(PORT_RANGE_START, PORT_RANGE_END + 1):
            if port in RESERVED_PORTS:
                continue
            if port in _SKIP_PORTS:
                continue
            if port in _assigned:
                continue
            if _is_port_free(port):
                _assigned[port] = session_id
                return port

        raise RuntimeError("No free port available for preview server.")


def release_port(port: int) -> None:
    """Release a previously allocated port back to the pool."""
    with _lock:
        _assigned.pop(port, None)


def release_session(session_id: str) -> None:
    """Release all ports held by a session."""
    with _lock:
        to_remove = [p for p, sid in _assigned.items() if sid == session_id]
        for p in to_remove:
            _assigned.pop(p, None)


class ReservedPortError(RuntimeError):
    """Raised when an operation attempts to use a port reserved for AI-Bolt."""
    pass


def inject_port_into_command(command: str, port: int, framework: Optional[str] = None) -> str:
    """Inject a port flag into a dev-server command for the given framework.

    This ensures the server binds to the allocated port rather than its
    default (which might be 5173 or 8000).  For frameworks where we can't
    reliably add a flag, the caller should also set the PORT env var.
    """
    if is_reserved(port):
        raise ReservedPortError(
            f"Port {port} is reserved for AI-Bolt and cannot be used."
        )

    fw = (framework or "").lower()
    port_str = str(port)

    # Vite: add --port and --strictPort so it fails instead of silently
    # jumping to another port (which could land on 5173).
    if fw == "vite":
        if "--port" not in command:
            command = f"{command} --port {port_str} --strictPort"
        return command

    # Next.js: add --port flag.
    if fw == "next":
        if "--port" not in command:
            command = f"{command} --port {port_str}"
        return command

    # NestJS: add --port.
    if fw == "nest":
        if "--port" not in command:
            command = f"{command} --port {port_str}"
        return command

    # Laravel artisan serve: add --port.
    if "artisan serve" in command:
        if "--port" not in command:
            command = f"{command} --port {port_str}"
        return command

    # PHP built-in server: replace the :PORT in the command.
    if "php -S" in command:
        import re
        command = re.sub(
            r"(php\s+-S\s+\S+):\d+",
            lambda m: f"{m.group(1)}:{port_str}",
            command,
        )
        if ":" + port_str not in command:
            command = command.replace("php -S", f"php -S 127.0.0.1:{port_str}")
        return command

    # Generic: append --port as a best-effort (works for many Node scripts
    # that pass it through, and is harmless if ignored).
    if "--port" not in command and "-p " not in command:
        command = f"{command} --port {port_str}"
    return command