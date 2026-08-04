"""HTTP target validation helpers for outbound web tools."""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import urljoin, urlparse

import httpx

from myharness.utils.certificates import httpx_verify_argument


_DEFAULT_PORTS = {
    "http": 80,
    "https": 443,
}
DEFAULT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024
_IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address


class NetworkGuardError(ValueError):
    """Raised when an outbound HTTP target violates security policy."""


def validate_http_url(url: str) -> None:
    """Validate basic HTTP/HTTPS URL syntax."""
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise NetworkGuardError("only http and https URLs are allowed")
    if not parsed.netloc or not parsed.hostname:
        raise NetworkGuardError("URL must include a host")
    if parsed.username or parsed.password:
        raise NetworkGuardError("URLs with embedded credentials are not allowed")


async def ensure_public_http_url(url: str) -> None:
    """Reject loopback, private-network, and other non-public HTTP targets."""
    validate_http_url(url)
    parsed = urlparse(url)
    assert parsed.hostname is not None  # covered by validate_http_url
    port = parsed.port or _DEFAULT_PORTS[parsed.scheme]
    addresses = await _resolve_host_addresses(parsed.hostname, port)
    if not addresses:
        raise NetworkGuardError(f"target host did not resolve: {parsed.hostname}")

    blocked = sorted({str(address) for address in addresses if not address.is_global})
    if blocked:
        rendered = ", ".join(blocked[:3])
        if len(blocked) > 3:
            rendered += ", ..."
        raise NetworkGuardError(f"target resolves to non-public address(es): {rendered}")


async def fetch_public_http_response(
    url: str,
    *,
    headers: dict[str, str] | None = None,
    params: dict[str, str] | None = None,
    timeout: float = 15.0,
    max_redirects: int = 5,
    max_response_bytes: int = DEFAULT_MAX_RESPONSE_BYTES,
) -> httpx.Response:
    """Fetch one HTTP resource while validating every redirect hop."""
    current_url = url
    current_params = params

    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        trust_env=False,
        verify=httpx_verify_argument(),
    ) as client:
        for redirect_count in range(max_redirects + 1):
            await ensure_public_http_url(current_url)
            async with client.stream(
                "GET",
                current_url,
                params=current_params,
                headers=headers,
            ) as response:
                if response.has_redirect_location:
                    location = response.headers.get("location")
                    if not location:
                        return _copy_response(response, b"")
                    if redirect_count >= max_redirects:
                        raise NetworkGuardError(f"too many redirects (>{max_redirects})")
                    current_url = urljoin(str(response.url), location)
                    current_params = None
                    continue

                content = await _read_bounded_response_body(response, max_response_bytes)
                return _copy_response(response, content)

    raise NetworkGuardError("request failed before receiving a response")


async def _read_bounded_response_body(response: httpx.Response, max_bytes: int) -> bytes:
    declared = response.headers.get("content-length")
    if declared:
        try:
            declared_bytes = int(declared)
        except ValueError:
            declared_bytes = 0
        if declared_bytes > max_bytes:
            raise NetworkGuardError(f"response body exceeds {max_bytes} bytes")

    body = bytearray()
    async for chunk in response.aiter_bytes():
        body.extend(chunk)
        if len(body) > max_bytes:
            raise NetworkGuardError(f"response body exceeds {max_bytes} bytes")
    return bytes(body)


def _copy_response(response: httpx.Response, content: bytes) -> httpx.Response:
    headers = response.headers.copy()
    headers.pop("content-encoding", None)
    headers.pop("content-length", None)
    return httpx.Response(
        status_code=response.status_code,
        headers=headers,
        content=content,
        request=response.request,
        extensions=response.extensions,
    )


async def _resolve_host_addresses(host: str, port: int) -> set[_IPAddress]:
    """Resolve a host into concrete IP addresses."""
    literal = _parse_ip_literal(host)
    if literal is not None:
        return {literal}

    try:
        infos = await asyncio.to_thread(
            socket.getaddrinfo,
            host,
            port,
            socket.AF_UNSPEC,
            socket.SOCK_STREAM,
        )
    except OSError as exc:
        raise NetworkGuardError(f"could not resolve target host {host}: {exc}") from exc

    addresses: set[_IPAddress] = set()
    for family, _, _, _, sockaddr in infos:
        if family == socket.AF_INET:
            candidate = sockaddr[0]
        elif family == socket.AF_INET6:
            candidate = sockaddr[0]
        else:
            continue
        parsed = _parse_ip_literal(candidate)
        if parsed is not None:
            addresses.add(parsed)
    return addresses


def _parse_ip_literal(value: str) -> _IPAddress | None:
    try:
        return ipaddress.ip_address(value)
    except ValueError:
        return None
