"""Provider token pricing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from myharness.api.usage import UsageSnapshot


@dataclass(frozen=True)
class TokenPricing:
    input_usd_per_million: float
    cached_input_usd_per_million: float
    output_usd_per_million: float


OPENAI_PRICING: dict[str, TokenPricing] = {
    "gpt-5.5": TokenPricing(5.0, 0.5, 30.0),
    "gpt-5.4": TokenPricing(2.5, 0.25, 15.0),
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
        "uncached_input_tokens": usage.uncached_input_tokens,
        "output_tokens": usage.output_tokens,
        "total_tokens": usage.total_tokens,
        "cache_hit_ratio": cache_hit_ratio,
    }


def estimate_usage_cost(provider: str, model: str, usage: UsageSnapshot) -> dict[str, Any]:
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
    uncached_input_cost = usage.uncached_input_tokens * pricing.input_usd_per_million / 1_000_000
    cached_input_cost = usage.cached_input_tokens * pricing.cached_input_usd_per_million / 1_000_000
    output_cost = usage.output_tokens * pricing.output_usd_per_million / 1_000_000
    cost = uncached_input_cost + cached_input_cost + output_cost
    uncached_baseline_cost = (
        usage.input_tokens * pricing.input_usd_per_million
        + usage.output_tokens * pricing.output_usd_per_million
    ) / 1_000_000
    payload.update(
        {
            "estimated_cost_usd": cost,
            "estimated_cache_savings_usd": max(0.0, uncached_baseline_cost - cost),
            "estimated_uncached_input_cost_usd": uncached_input_cost,
            "estimated_cached_input_cost_usd": cached_input_cost,
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
        if entry_usage.total_tokens or entry_usage.cached_input_tokens:
            breakdown.append(estimate_usage_cost(entry_provider, entry_model, entry_usage))

    if not breakdown and (total_usage.total_tokens or total_usage.cached_input_tokens):
        breakdown.append(estimate_usage_cost(provider, model, total_usage))

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
    total_output_cost = (
        sum(float(item.get("estimated_output_cost_usd") or 0.0) for item in supported_breakdown)
        if all_supported
        else None
    )
    note = "openai_pricing_estimate" if all_supported else (
        breakdown[0].get("cost_note") if len(breakdown) == 1 else "mixed_or_unsupported_models"
    )
    if not breakdown and not (total_usage.total_tokens or total_usage.cached_input_tokens):
        note = "no_usage"
        total_cost = 0.0
        total_savings = 0.0
        total_uncached_input_cost = 0.0
        total_cached_input_cost = 0.0
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
        "estimated_output_cost_usd": total_output_cost,
        "cost_supported": all_supported,
        "cost_note": note,
        "model_breakdown": breakdown,
    }
