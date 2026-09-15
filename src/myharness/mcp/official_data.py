"""Shared helpers for official public-data MCP adapters."""

from __future__ import annotations

import json
import logging
import os
import re
import ssl
import time
import threading
import hashlib
import sqlite3
from pathlib import Path
from datetime import UTC, datetime
from collections.abc import Callable
from contextlib import closing, contextmanager
from typing import Any

import httpx


TRANSIENT_STATUS_CODES = {408, 429, 500, 502, 503, 504}
MAX_REQUEST_ATTEMPTS = 3
_REQUEST_SLOT_LOCK = threading.Lock()
_REQUEST_SLOTS: dict[str, float] = {}
_REQUEST_SOURCE_LOCKS: dict[str, threading.Lock] = {}


def _wait_shared_request_slot(source: str, headers: dict[str, str] | None, interval: float) -> None:
    """Share a credential's request budget across MCP processes on this host."""
    if interval <= 0 or not headers:
        return
    identity = hashlib.sha256(json.dumps([source, sorted(headers.items())]).encode()).hexdigest()
    folder = Path(os.environ.get("MYHARNESS_CONFIG_DIR") or Path.home() / ".myharness")
    folder.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(folder / "mcp-rate-limits.sqlite3", timeout=15)) as connection, connection:
        connection.execute("CREATE TABLE IF NOT EXISTS request_slots (id TEXT PRIMARY KEY, next_at REAL NOT NULL)")
        connection.execute("BEGIN IMMEDIATE")
        row = connection.execute("SELECT next_at FROM request_slots WHERE id=?", (identity,)).fetchone()
        now = time.time()
        slot = max(now, row[0] if row else now)
        connection.execute("INSERT OR REPLACE INTO request_slots VALUES (?, ?)", (identity, slot + interval))
    if slot > now:
        time.sleep(slot - now)


def _wait_request_slot(source: str, minimum_interval: float) -> None:
    if minimum_interval <= 0:
        return
    with _REQUEST_SLOT_LOCK:
        now = time.monotonic()
        slot = max(now, _REQUEST_SLOTS.get(source, now))
        _REQUEST_SLOTS[source] = slot + minimum_interval
    if slot > now:
        time.sleep(slot - now)


@contextmanager
def _paced_request(source: str, minimum_interval: float):
    if minimum_interval <= 0:
        yield
        return
    with _REQUEST_SLOT_LOCK:
        lock = _REQUEST_SOURCE_LOCKS.setdefault(source, threading.Lock())
    with lock:
        _wait_request_slot(source, minimum_interval)
        try:
            yield
        finally:
            # Space completed requests as well as starts; concurrent tool calls
            # must not burst against a single API key after a slow response.
            with _REQUEST_SLOT_LOCK:
                _REQUEST_SLOTS[source] = time.monotonic() + minimum_interval

# httpx logs the fully rendered request URL at INFO level. Several official APIs
# put credentials in the query string, so allowing that log would disclose keys.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)


def first_env(*names: str) -> str | None:
    """Return the first non-empty environment variable in ``names``."""
    for name in names:
        value = os.environ.get(name)
        if value and value.strip():
            return value.strip()
    return None


def httpx_verify_argument() -> bool | ssl.SSLContext:
    """Return the MyHarness-aware TLS verification configuration."""
    try:
        from myharness.utils.certificates import httpx_verify_argument as configured_verify
    except ImportError:
        bundle = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
        if not bundle:
            return True
        context = ssl.create_default_context()
        try:
            context.set_ciphers("DEFAULT@SECLEVEL=1")
        except ssl.SSLError:
            pass
        if hasattr(ssl, "VERIFY_X509_STRICT"):
            context.verify_flags &= ~ssl.VERIFY_X509_STRICT
        context.load_verify_locations(cafile=bundle)
        return context
    return configured_verify()


def clean_limit(limit: int, *, maximum: int = 1000) -> int:
    """Clamp a caller-provided row limit to a safe positive range."""
    return max(1, min(int(limit), maximum))


def safe_identifier(
    value: str,
    *,
    field_name: str,
    pattern: str = r"[A-Za-z0-9_.:-]+",
) -> str:
    """Validate identifiers before interpolating them into URL paths."""
    token = value.strip()
    if not token or not re.fullmatch(pattern, token):
        raise ValueError(f"{field_name} has an invalid format.")
    return token


def request(
    source: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 45,
    minimum_interval: float = 0,
) -> httpx.Response:
    """Issue a retrying GET without leaking query parameters in raised messages."""
    last_error: BaseException | None = None
    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        try:
            with _paced_request(source, minimum_interval):
                _wait_shared_request_slot(source, headers, minimum_interval)
                response = httpx.get(
                    url,
                    params={key: value for key, value in (params or {}).items() if value is not None},
                    headers=headers,
                    timeout=timeout,
                    verify=httpx_verify_argument(),
                    follow_redirects=True,
                )
            if response.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_REQUEST_ATTEMPTS:
                retry_after = response.headers.get("Retry-After", "")
                delay = min(float(retry_after), 60) if re.fullmatch(r"\d+(\.\d+)?", retry_after) else min(0.25 * attempt, 1.0)
                time.sleep(delay)
                continue
            response.raise_for_status()
            return response
        except (
            httpx.ConnectError,
            httpx.ConnectTimeout,
            httpx.HTTPStatusError,
            httpx.ProxyError,
            httpx.ReadError,
            httpx.ReadTimeout,
            httpx.RemoteProtocolError,
            OSError,
            ssl.SSLError,
        ) as exc:
            last_error = exc
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            retryable = not isinstance(exc, httpx.HTTPStatusError) or status in TRANSIENT_STATUS_CODES
            if not retryable or attempt == MAX_REQUEST_ATTEMPTS:
                break
            time.sleep(min(0.25 * attempt, 1.0))
    status = last_error.response.status_code if isinstance(last_error, httpx.HTTPStatusError) else None
    raise RuntimeError(
        f"{source} request failed{f' (HTTP {status})' if status else ''}. Check the credential, service status, corporate proxy, "
        "HTTPS_PROXY, and SSL_CERT_FILE settings."
    ) from last_error


def request_json(
    source: str,
    url: str,
    *,
    params: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 45,
    fallback_encoding: str | None = None,
    empty_status_codes: tuple[int, ...] = (),
    minimum_interval: float = 0,
) -> object:
    """Fetch a JSON response and emit a bounded content diagnostic on parse failure."""
    response = request(source, url, params=params, headers=headers, timeout=timeout, minimum_interval=minimum_interval)
    if response.status_code in empty_status_codes:
        return []
    try:
        try:
            return response.json()
        except UnicodeDecodeError:
            if fallback_encoding is None:
                raise
            return json.loads(response.content.decode(fallback_encoding))
    except ValueError as exc:
        content_type = response.headers.get("content-type", "")
        raise RuntimeError(
            f"{source} returned non-JSON content. content_type={content_type!r} "
            f"response_bytes={len(response.content)}"
        ) from exc


def post_form_json(
    source: str,
    url: str,
    *,
    data: dict[str, Any],
    headers: dict[str, str] | None = None,
    auth: tuple[str, str] | None = None,
    timeout: float = 45,
) -> object:
    """POST a small form with bounded retries and secret-safe errors."""
    last_error: BaseException | None = None
    for attempt in range(1, MAX_REQUEST_ATTEMPTS + 1):
        try:
            response = httpx.post(
                url,
                data=data,
                headers=headers,
                auth=auth,
                timeout=timeout,
                verify=httpx_verify_argument(),
                follow_redirects=True,
            )
            if response.status_code in TRANSIENT_STATUS_CODES and attempt < MAX_REQUEST_ATTEMPTS:
                time.sleep(min(0.25 * attempt, 1.0))
                continue
            response.raise_for_status()
            return response.json()
        except (httpx.HTTPError, ValueError, OSError, ssl.SSLError) as exc:
            last_error = exc
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            retryable = not isinstance(exc, httpx.HTTPStatusError) or status in TRANSIENT_STATUS_CODES
            if not retryable or attempt == MAX_REQUEST_ATTEMPTS:
                break
            time.sleep(min(0.25 * attempt, 1.0))
    raise RuntimeError(
        f"{source} authentication request failed. Check the credential, service status, "
        "corporate proxy, HTTPS_PROXY, and SSL_CERT_FILE settings."
    ) from last_error


def result_envelope(
    *,
    source: str,
    source_id: str,
    data: object,
    as_of: str | None = None,
    unit: str | None = None,
    revision: str | None = None,
    completeness: str = "reported_by_source",
    license_name: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> str:
    """Return the common provenance envelope required by official-data MCPs."""
    payload: dict[str, Any] = {
        "source": source,
        "source_id": source_id,
        "retrieved_at": datetime.now(UTC).isoformat(),
        "as_of": as_of,
        "unit": unit,
        "revision": revision,
        "completeness": completeness,
        "license": license_name,
        "data": data,
    }
    if metadata:
        payload["metadata"] = metadata
    return json.dumps(payload, ensure_ascii=False, indent=2)


def health_envelope(
    *,
    source: str,
    ok: bool,
    credential_env: tuple[str, ...] = (),
    require_all_credentials: bool = False,
    detail: str,
) -> str:
    """Return connection state while exposing only credential presence, never values."""
    return json.dumps(
        {
            "source": source,
            "ok": ok,
            "retrieved_at": datetime.now(UTC).isoformat(),
            "credential": {
                "required": bool(credential_env),
                "configured": bool(credential_env) and (
                    all(first_env(name) for name in credential_env)
                    if require_all_credentials else bool(first_env(*credential_env))
                ),
                "environment_names": list(credential_env),
            },
            "detail": detail,
        },
        ensure_ascii=False,
        indent=2,
    )


def checked_health_envelope(
    *,
    source: str,
    probe: Callable[[], object],
    success_detail: str,
    credential_env: tuple[str, ...] = (),
    require_all_credentials: bool = False,
    missing_detail: str = "Official API adapter is installed but its credential is not configured.",
) -> str:
    """Run one health probe and always return a secret-safe health envelope."""
    configured = (
        all(first_env(name) for name in credential_env)
        if require_all_credentials else bool(first_env(*credential_env))
    )
    if credential_env and not configured:
        return health_envelope(
            source=source,
            ok=False,
            credential_env=credential_env,
            require_all_credentials=require_all_credentials,
            detail=missing_detail,
        )
    try:
        probe()
    except Exception as exc:  # health tools must report failures instead of crashing
        cause: BaseException = exc
        while cause.__cause__ is not None:
            cause = cause.__cause__
        failure = (
            f"HTTP {cause.response.status_code}"
            if isinstance(cause, httpx.HTTPStatusError)
            else type(cause).__name__
        )
        return health_envelope(
            source=source,
            ok=False,
            credential_env=credential_env,
            require_all_credentials=require_all_credentials,
            detail=f"Official endpoint probe failed ({failure}).",
        )
    return health_envelope(
        source=source,
        ok=True,
        credential_env=credential_env,
        require_all_credentials=require_all_credentials,
        detail=success_detail,
    )
