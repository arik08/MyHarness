from __future__ import annotations

from myharness.api.pricing import estimate_usage_cost, usage_cost_summary
from myharness.api.usage import UsageSnapshot


def test_estimate_usage_cost_applies_cached_input_discount():
    usage = UsageSnapshot(input_tokens=1_000_000, cached_input_tokens=900_000, output_tokens=100_000)

    payload = estimate_usage_cost("openai", "gpt-5.4", usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 100_000
    assert payload["estimated_cost_usd"] == 1.975


def test_estimate_usage_cost_supports_pgpt_openai_compatible_pricing():
    usage = UsageSnapshot(input_tokens=16_490, cached_input_tokens=15_872, output_tokens=43)

    payload = estimate_usage_cost("pgpt", "gpt-5.4", usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 618
    assert payload["estimated_cost_usd"] == 0.006158


def test_estimate_usage_cost_supports_codex_openai_compatible_pricing():
    usage = UsageSnapshot(input_tokens=16_584, cached_input_tokens=10_752, output_tokens=63)

    payload = estimate_usage_cost("openai_codex", "gpt-5.5", usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 5832
    assert payload["estimated_cost_usd"] == 0.036426


def test_usage_cost_summary_returns_null_cost_for_unsupported_model():
    payload = usage_cost_summary(
        {
            "total": UsageSnapshot(input_tokens=1000, output_tokens=200).model_dump(),
            "by_model": [
                {
                    "provider": "openai",
                    "model": "gpt-unknown",
                    "usage": UsageSnapshot(input_tokens=1000, output_tokens=200).model_dump(),
                }
            ],
        }
    )

    assert payload["cost_supported"] is False
    assert payload["estimated_cost_usd"] is None
    assert payload["cost_note"] == "unsupported_model"
