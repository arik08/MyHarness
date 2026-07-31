from __future__ import annotations

from types import SimpleNamespace

from myharness.api.retry import calculate_retry_delay


def test_retry_delay_adds_jitter_to_exponential_backoff(monkeypatch):
    monkeypatch.setattr("myharness.api.retry.random.uniform", lambda low, high: high)

    assert calculate_retry_delay(0, base_delay=1.0, max_delay=30.0) == 1.25
    assert calculate_retry_delay(2, base_delay=1.0, max_delay=30.0) == 5.0


def test_retry_delay_honors_retry_after_header_before_jitter():
    exc = RuntimeError("rate limited")
    exc.response = SimpleNamespace(headers={"retry-after": "7.5"})  # type: ignore[attr-defined]

    assert calculate_retry_delay(0, exc, base_delay=1.0, max_delay=30.0) == 7.5


def test_retry_delay_caps_retry_after_and_exponential_jitter(monkeypatch):
    monkeypatch.setattr("myharness.api.retry.random.uniform", lambda low, high: high)
    exc = RuntimeError("rate limited")
    exc.headers = {"retry-after": "120"}  # type: ignore[attr-defined]

    assert calculate_retry_delay(0, exc, max_delay=30.0) == 30.0
    assert calculate_retry_delay(10, max_delay=30.0) == 30.0
