"""API error types for MyHarness."""

from __future__ import annotations


class MyHarnessApiError(RuntimeError):
    """Base class for upstream API failures."""


class AuthenticationFailure(MyHarnessApiError):
    """Raised when the upstream service rejects the provided credentials."""


class RateLimitFailure(MyHarnessApiError):
    """Raised when the upstream service rejects the request due to rate limits."""


class RequestFailure(MyHarnessApiError):
    """Raised for generic request or transport failures."""
