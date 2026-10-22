"""SSRF guard for validating user-supplied provider endpoints.

Custom base URLs are powerful but dangerous: they can target internal services,
cloud metadata endpoints, or private networks. This module validates URLs and
rejects unsafe destinations.

Rules:
  - Only http and https schemes are allowed.
  - Remote providers must use HTTPS.
  - HTTP is allowed only for explicitly permitted local development endpoints
    (controlled by `allow_local_http` and `local_endpoint_hosts`).
  - Requests to cloud metadata services (169.254.169.254) are always rejected.
  - Requests to non-routable / private / loopback networks are rejected unless
    the host is in the local endpoint allowlist AND local HTTP is permitted.
  - Redirects are NOT followed by the HTTP client; the caller must validate
    the final URL. The adapter layer disables redirect following.
"""
from __future__ import annotations

import ipaddress
import socket
from typing import Optional
from urllib.parse import urlparse

from fastapi import HTTPException, status

from app.config import settings, local_endpoint_allowlist


class UnsafeEndpointError(HTTPException):
    def __init__(self, detail: str):
        super().__init__(status.HTTP_400_BAD_REQUEST, detail)


def validate_endpoint(url: str, *, require_https: bool = True) -> str:
    """Validate and return a normalized endpoint URL.

    Raises UnsafeEndpointError (HTTP 400) if the endpoint is unsafe or
    misconfigured. Never follows redirects — that is the caller's duty.
    """
    if not isinstance(url, str) or not url.strip():
        raise UnsafeEndpointError("Endpoint URL is required.")

    parsed = urlparse(url.strip())
    scheme = (parsed.scheme or "").lower()
    if scheme not in ("http", "https"):
        raise UnsafeEndpointError("Only http and https endpoints are supported.")

    if require_https and scheme == "http":
        # Allow plain HTTP only for explicit local development hosts.
        host = (parsed.hostname or "").lower()
        allow = local_endpoint_allowlist()
        if not settings.allow_local_http or host not in allow:
            raise UnsafeEndpointError(
                "Remote providers must use HTTPS. Plain HTTP is allowed only "
                "for explicitly permitted local development endpoints."
            )

    host = (parsed.hostname or "").lower()
    if not host:
        raise UnsafeEndpointError("Endpoint URL must include a host.")

    # Always block the cloud metadata endpoint.
    if host in ("169.254.169.254", "metadata.google.internal"):
        raise UnsafeEndpointError("Requests to cloud metadata services are not allowed.")

    # Resolve the host and check the address family. If the host is a DNS name
    # that resolves to a private IP, reject unless it is an allowed local host.
    _check_address(host)

    # Reject userinfo in the URL (credential leakage via URL).
    if parsed.username or parsed.password:
        raise UnsafeEndpointError("Credentials in the endpoint URL are not allowed.")

    # Re-emit the cleaned URL.
    return parsed.geturl()


def _check_address(host: str) -> None:
    allow = local_endpoint_allowlist()
    # If the host is an allowed local hostname, permit loopback addresses.
    is_local_allowed = host in allow

    # Try to parse as an IP literal first.
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        # DNS name — resolve and inspect each address.
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror:
            # Unresolvable is fine at validation time; the HTTP call will fail.
            return
        for info in infos:
            sa = info[4][0]
            try:
                addr = ipaddress.ip_address(sa)
            except ValueError:
                continue
            _check_ip(addr, host, is_local_allowed)
        return

    _check_ip(ip, host, is_local_allowed)


def _check_ip(ip: ipaddress._BaseAddress, host: str, is_local_allowed: bool) -> None:
    # Always block the metadata subnet.
    if ip in ipaddress.ip_network("169.254.0.0/16"):
        raise UnsafeEndpointError("Requests to link-local addresses are not allowed.")
    if ip.is_loopback:
        if is_local_allowed and settings.allow_local_http:
            return
        raise UnsafeEndpointError(
            "Requests to loopback addresses are not allowed unless the host is "
            "an explicitly permitted local development endpoint."
        )
    if ip.is_private or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
        if is_local_allowed and settings.allow_local_http:
            return
        raise UnsafeEndpointError("Requests to private or reserved networks are not allowed.")


def safe_request_kwargs(timeout: float = 20.0) -> dict:
    """Return httpx request kwargs that disable redirects and enforce a timeout.

    Redirects are disabled to prevent credential leakage through redirects to
    prohibited destinations. Adapters MUST use these kwargs (or equivalent).
    """
    return {
        "timeout": timeout,
        "follow_redirects": False,
    }
