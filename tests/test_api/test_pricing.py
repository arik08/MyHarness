from __future__ import annotations

import pytest

from myharness.api.pricing import estimate_usage_cost, usage_cost_summary
from myharness.api.usage import UsageSnapshot


def test_estimate_usage_cost_applies_cached_input_discount():
    usage = UsageSnapshot(input_tokens=1_000_000, cached_input_tokens=900_000, output_tokens=100_000)

    payload = estimate_usage_cost("openai", "gpt-5.4", usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 100_000
    assert payload["cache_hit_ratio"] == 0.9
    assert payload["estimated_cost_usd"] == 1.975
    assert payload["estimated_cache_savings_usd"] == pytest.approx(2.025)
    assert payload["estimated_uncached_input_cost_usd"] == 0.25
    assert payload["estimated_cached_input_cost_usd"] == 0.225
    assert payload["estimated_output_cost_usd"] == 1.5


def test_estimate_usage_cost_supports_pgpt_openai_compatible_pricing():
    usage = UsageSnapshot(input_tokens=16_490, cached_input_tokens=15_872, output_tokens=43)

    payload = estimate_usage_cost("pgpt", "gpt-5.4", usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 618
    assert payload["estimated_cost_usd"] == 0.006158
    assert payload["estimated_cache_savings_usd"] == pytest.approx(0.035712)
    assert payload["estimated_uncached_input_cost_usd"] == pytest.approx(0.001545)
    assert payload["estimated_cached_input_cost_usd"] == pytest.approx(0.003968)
    assert payload["estimated_output_cost_usd"] == pytest.approx(0.000645)


@pytest.mark.parametrize(
    ("model", "expected_cost"),
    [
        ("gpt-5.6-sol", 6.325),
        ("gpt-5.6-terra", 3.1625),
        ("gpt-5.6-luna", 1.265),
    ],
)
def test_estimate_usage_cost_supports_gpt56_cache_write_pricing(model, expected_cost):
    usage = UsageSnapshot(
        input_tokens=1_000_000,
        cached_input_tokens=400_000,
        cache_write_tokens=100_000,
        output_tokens=100_000,
    )

    payload = estimate_usage_cost("pgpt", model, usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 500_000
    assert payload["cache_write_tokens"] == 100_000
    assert payload["estimated_cost_usd"] == pytest.approx(expected_cost)
    assert payload["estimated_cache_write_cost_usd"] == pytest.approx(
        {"gpt-5.6-sol": 0.625, "gpt-5.6-terra": 0.3125, "gpt-5.6-luna": 0.125}[model]
    )


def test_estimate_usage_cost_supports_codex_openai_compatible_pricing():
    usage = UsageSnapshot(input_tokens=16_584, cached_input_tokens=10_752, output_tokens=63)

    payload = estimate_usage_cost("openai_codex", "gpt-5.5", usage)

    assert payload["cost_supported"] is True
    assert payload["uncached_input_tokens"] == 5832
    assert payload["estimated_cost_usd"] == 0.036426
    assert payload["estimated_uncached_input_cost_usd"] == pytest.approx(0.02916)
    assert payload["estimated_cached_input_cost_usd"] == pytest.approx(0.005376)
    assert payload["estimated_output_cost_usd"] == pytest.approx(0.00189)


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
    assert payload["estimated_cache_savings_usd"] is None
    assert payload["estimated_uncached_input_cost_usd"] is None
    assert payload["estimated_cached_input_cost_usd"] is None
    assert payload["estimated_output_cost_usd"] is None
    assert payload["cost_note"] == "unsupported_model"
