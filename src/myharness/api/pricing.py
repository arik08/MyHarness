"""Provider token pricing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from myharness.api.usage import UsageSnapshot, subtract_usage_snapshots


LONG_CONTEXT_INPUT_TOKEN_THRESHOLD = 272_000


@dataclass(frozen=True)
class TokenPricing:
    input_usd_per_million: float
    cached_input_usd_per_million: float
    output_usd_per_million: float
    cache_write_usd_per_million: float | None = None
    long_input_usd_per_million: float | None = None
    long_cached_input_usd_per_million: float | None = None
    long_output_usd_per_million: float | None = None
    long_cache_write_usd_per_million: float | None = None


OPENAI_PRICING: dict[str, TokenPricing] = {
    "gpt-5.6-sol": TokenPricing(5.0, 0.5, 30.0, 6.25, 10.0, 1.0, 45.0, 12.5),
    "gpt-5.6-terra": TokenPricing(2.0, 0.2, 12.0, 2.5, 4.0, 0.4, 18.0, 5.0),
    "gpt-5.6-luna": TokenPricing(0.2, 0.02, 1.2, 0.25, 0.4, 0.04, 1.8, 0.5),
    "gpt-5.5": TokenPricing(5.0, 0.5, 30.0, None, 10.0, 1.0, 45.0),
    "gpt-5.4": TokenPricing(2.5, 0.25, 15.0, None, 5.0, 0.5, 22.5),
    "gpt-5.4-mini": TokenPricing(0.75, 0.075, 4.5),
}

OPENAI_PRICING_PROVIDERS = {
    "codex",
    "openai",
    "openai-compatible",
    "openai_compat",
    "openai_codex",
    "pgpt",
}


def normalize_pricing_model(model: str) -> str:
    normalized = str(model or "").strip().lower().replace("_", "-")
    if normalized in {"gpt-5.4 mini", "gpt-5.4mini"}:
        return "gpt-5.4-mini"
    return normalized


def uses_long_context_pricing(model: str, input_tokens: int) -> bool:
    pricing = OPENAI_PRICING.get(normalize_pricing_model(model))
    return bool(
        pricing
        and pricing.long_input_usd_per_million is not None
        and input_tokens > LONG_CONTEXT_INPUT_TOKEN_THRESHOLD
    )


def _coerce_usage(value: Any) -> UsageSnapshot:
    if isinstance(value, UsageSnapshot):
        return value
    if isinstance(value, dict):
        try:
            return UsageSnapshot.model_validate(value)
        except Exception:
            return UsageSnapshot()
    return UsageSnapshot()


def _usage_payload_fields(usage: UsageSnapshot) -> dict[str, Any]:
    cache_hit_ratio = usage.cached_input_tokens / usage.input_tokens if usage.input_tokens > 0 else 0.0
    return {
        "input_tokens": usage.input_tokens,
        "cached_input_tokens": usage.cached_input_tokens,
        "cache_write_tokens": usage.cache_write_tokens,
        "uncached_input_tokens": usage.uncached_input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "cache_hit_ratio": cache_hit_ratio,
    }


def estimate_usage_cost(
    provider: str,
    model: str,
    usage: UsageSnapshot,
    *,
    long_context_usage: UsageSnapshot | None = None,
) -> dict[str, Any]:
    """Build a serializable usage/cost payload for a single provider/model bucket."""
    provider_name = str(provider or "").strip()
    model_name = str(model or "").strip()
    normalized_provider = provider_name.lower().replace("_", "-")
    normalized_model = normalize_pricing_model(model_name)
    payload: dict[str, Any] = {
        "provider": provider_name,
        "model": model_name,
        **_usage_payload_fields(usage),
        "estimated_cost_usd": None,
        "estimated_cache_savings_usd": None,
        "estimated_uncached_input_cost_usd": None,
        "estimated_cached_input_cost_usd": None,
        "estimated_cache_write_cost_usd": None,
        "estimated_output_cost_usd": None,
        "cost_supported": False,
        "cost_note": "unsupported_provider",
    }
    if normalized_provider not in {item.replace("_", "-") for item in OPENAI_PRICING_PROVIDERS}:
        return payload
    pricing = OPENAI_PRICING.get(normalized_model)
    if pricing is None:
        payload["cost_note"] = "unsupported_model"
        return payload
    if usage.cache_write_tokens and pricing.cache_write_usd_per_million is None:
        payload["cost_note"] = "unsupported_cache_write_pricing"
        return payload
    if long_context_usage is None:
        long_context_usage = usage if uses_long_context_pricing(model_name, usage.input_tokens) else UsageSnapshot()
    short_context_usage = subtract_usage_snapshots(usage, long_context_usage)
    if long_context_usage.total_tokens and pricing.long_input_usd_per_million is None:
        payload["cost_note"] = "unsupported_long_context_pricing"
        return payload
    if long_context_usage.cache_write_tokens and pricing.long_cache_write_usd_per_million is None:
        payload["cost_note"] = "unsupported_long_context_cache_write_pricing"
        return payload

    uncached_input_cost = (
        short_context_usage.uncached_input_tokens * pricing.input_usd_per_million
        + long_context_usage.uncached_input_tokens * float(pricing.long_input_usd_per_million or 0.0)
    ) / 1_000_000
    cached_input_cost = (
        short_context_usage.cached_input_tokens * pricing.cached_input_usd_per_million
        + long_context_usage.cached_input_tokens * float(pricing.long_cached_input_usd_per_million or 0.0)
    ) / 1_000_000
    cache_write_cost = (
        short_context_usage.cache_write_tokens * float(pricing.cache_write_usd_per_million or 0.0)
        + long_context_usage.cache_write_tokens * float(pricing.long_cache_write_usd_per_million or 0.0)
    ) / 1_000_000
    output_cost = (
        short_context_usage.output_tokens * pricing.output_usd_per_million
        + long_context_usage.output_tokens * float(pricing.long_output_usd_per_million or 0.0)
    ) / 1_000_000
    cost = uncached_input_cost + cached_input_cost + cache_write_cost + output_cost
    uncached_baseline_cost = (
        short_context_usage.input_tokens * pricing.input_usd_per_million
        + short_context_usage.output_tokens * pricing.output_usd_per_million
        + long_context_usage.input_tokens * float(pricing.long_input_usd_per_million or 0.0)
        + long_context_usage.output_tokens * float(pricing.long_output_usd_per_million or 0.0)
    ) / 1_000_000
    payload.update(
        {
            "estimated_cost_usd": cost,
            "estimated_cache_savings_usd": max(0.0, uncached_baseline_cost - cost),
            "estimated_uncached_input_cost_usd": uncached_input_cost,
            "estimated_cached_input_cost_usd": cached_input_cost,
            "estimated_cache_write_cost_usd": cache_write_cost,
            "estimated_output_cost_usd": output_cost,
            "cost_supported": True,
            "cost_note": "openai_pricing_estimate",
        }
    )
    return payload


def usage_cost_summary(accounting: dict[str, Any], *, provider: str = "", model: str = "") -> dict[str, Any]:
    """Summarize usage accounting into the UI payload shape."""
    total_usage = _coerce_usage(accounting.get("total") if isinstance(accounting, dict) else None)
    entries = accounting.get("by_model", []) if isinstance(accounting, dict) else []
    breakdown: list[dict[str, Any]] = []
    for item in entries:
        if not isinstance(item, dict):
            continue
        entry_provider = str(item.get("provider") or provider or "")
        entry_model = str(item.get("model") or model or "")
        entry_usage = _coerce_usage(item.get("usage"))
        if entry_usage.total_tokens or entry_usage.cached_input_tokens or entry_usage.cache_write_tokens:
            breakdown.append(
                estimate_usage_cost(
                    entry_provider,
                    entry_model,
                    entry_usage,
                    long_context_usage=_coerce_usage(item.get("long_context_usage")),
                )
            )

    if not breakdown and (total_usage.total_tokens or total_usage.cached_input_tokens or total_usage.cache_write_tokens):
        breakdown.append(
            estimate_usage_cost(provider, model, total_usage, long_context_usage=UsageSnapshot())
        )

    supported_breakdown = [item for item in breakdown if item.get("cost_supported")]
    all_supported = bool(breakdown) and len(supported_breakdown) == len(breakdown)
    total_cost = (
        sum(float(item.get("estimated_cost_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    total_savings = (
        sum(float(item.get("estimated_cache_savings_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    total_uncached_input_cost = (
        sum(float(item.get("estimated_uncached_input_cost_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    total_cached_input_cost = (
        sum(float(item.get("estimated_cached_input_cost_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    total_cache_write_cost = (
        sum(float(item.get("estimated_cache_write_cost_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    total_output_cost = (
        sum(float(item.get("estimated_output_cost_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    note = "openai_pricing_estimate" if all_supported else (
        breakdown[0].get("cost_note") if len(breakdown) == 1 else "mixed_or_unsupported_models"
    )
    if not breakdown and not (
        total_usage.total_tokens or total_usage.cached_input_tokens or total_usage.cache_write_tokens
    ):
        note = "no_usage"
        total_cost = 0.0
        total_savings = 0.0
        total_uncached_input_cost = 0.0
        total_cached_input_cost = 0.0
        total_cache_write_cost = 0.0
        total_output_cost = 0.0
        all_supported = True

    return {
        "provider": str(provider or ""),
        "model": str(model or ""),
        **_usage_payload_fields(total_usage),
        "estimated_cost_usd": total_cost,
        "estimated_cache_savings_usd": total_savings,
        "estimated_uncached_input_cost_usd": total_uncached_input_cost,
        "estimated_cached_input_cost_usd": total_cached_input_cost,
        "estimated_cache_write_cost_usd": total_cache_write_cost,
        "estimated_output_cost_usd": total_output_cost,
        "cost_supported": all_supported,
        "cost_note": note,
        "model_breakdown": breakdown,
    }
