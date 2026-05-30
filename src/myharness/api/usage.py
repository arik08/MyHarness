"""Usage tracking models."""

from __future__ import annotations

from pydantic import BaseModel


class UsageSnapshot(BaseModel):
    """Token usage returned by the model provider."""

    input_tokens: int = 0
    output_tokens: int = 0
    cached_input_tokens: int = 0

    @property
    def uncached_input_tokens(self) -> int:
        """Return input tokens that were not served from the provider cache."""
        return max(0, self.input_tokens - self.cached_input_tokens)

    @property
    def total_tokens(self) -> int:
        """Return the total number of accounted tokens."""
        return self.input_tokens + self.output_tokens


def add_usage_snapshots(left: UsageSnapshot, right: UsageSnapshot) -> UsageSnapshot:
    """Return the sum of two usage snapshots."""
    return UsageSnapshot(
        input_tokens=left.input_tokens + right.input_tokens,
        output_tokens=left.output_tokens + right.output_tokens,
        cached_input_tokens=left.cached_input_tokens + right.cached_input_tokens,
    )


def subtract_usage_snapshots(left: UsageSnapshot, right: UsageSnapshot) -> UsageSnapshot:
    """Return a non-negative usage delta between two snapshots."""
    return UsageSnapshot(
        input_tokens=max(0, left.input_tokens - right.input_tokens),
        output_tokens=max(0, left.output_tokens - right.output_tokens),
        cached_input_tokens=max(0, left.cached_input_tokens - right.cached_input_tokens),
    )
