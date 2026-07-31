"""Shared retry delay calculation for provider clients."""

from __future__ import annotations

import random
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any


def calculate_retry_delay(
    attempt: int,
    exc: Exception | None = None,
    *,
    base_delay: float = 1.0,
    max_delay: float = 30.0,
    jitter_ratio: float = 0.25,
) -> float:
    """Return Retry-After or capped exponential backoff with random jitter."""
    retry_after = _retry_after_seconds(exc)
    if retry_after is not None:
        return min(max_delay, max(0.0, retry_after))

    exponential = min(base_delay * (2 ** max(0, attempt)), max_delay)
    jitter = random.uniform(0.0, exponential * max(0.0, jitter_ratio))
    return min(max_delay, exponential + jitter)


def _retry_after_seconds(exc: Exception | None) -> float | None:
    if exc is None:
        return None
    headers: Any = getattr(exc, "headers", None)
    if not hasattr(headers, "get"):
        response = getattr(exc, "response", None)
        headers = getattr(response, "headers", None)
    if not hasattr(headers, "get"):
        return None

    raw = headers.get("retry-after")
    if raw is None:
        return None
    try:
        return float(raw)
    except (TypeError, ValueError):
        pass
    try:
        retry_at = parsedate_to_datetime(str(raw))
    except (TypeError, ValueError, OverflowError):
        return None
    if retry_at.tzinfo is None:
        retry_at = retry_at.replace(tzinfo=timezone.utc)
    return (retry_at - datetime.now(timezone.utc)).total_seconds()
