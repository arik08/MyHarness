"""Simple usage aggregation."""

from __future__ import annotations

from typing import Any

from myharness.api.usage import UsageSnapshot, add_usage_snapshots, subtract_usage_snapshots


def _coerce_usage(value: Any) -> UsageSnapshot:
    if isinstance(value, UsageSnapshot):
        return value
    if isinstance(value, dict):
        try:
            return UsageSnapshot.model_validate(value)
        except Exception:
            return UsageSnapshot()
    return UsageSnapshot()


def _account_key(provider: str, model: str) -> str:
    return f"{provider.strip().lower()}\n{model.strip().lower()}"


def _account_entry(provider: str, model: str, usage: UsageSnapshot) -> dict[str, Any]:
    return {
        "provider": provider,
        "model": model,
        "usage": usage.model_dump(mode="json"),
    }


def usage_accounting_delta(later: dict[str, Any], earlier: dict[str, Any]) -> dict[str, Any]:
    """Return a non-negative accounting delta between two tracker snapshots."""
    later_total = _coerce_usage(later.get("total") if isinstance(later, dict) else None)
    earlier_total = _coerce_usage(earlier.get("total") if isinstance(earlier, dict) else None)
    earlier_by_key = {}
    for item in earlier.get("by_model", []) if isinstance(earlier, dict) else []:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "")
        model = str(item.get("model") or "")
        earlier_by_key[_account_key(provider, model)] = _coerce_usage(item.get("usage"))

    entries: list[dict[str, Any]] = []
    for item in later.get("by_model", []) if isinstance(later, dict) else []:
        if not isinstance(item, dict):
            continue
        provider = str(item.get("provider") or "")
        model = str(item.get("model") or "")
        usage = subtract_usage_snapshots(
            _coerce_usage(item.get("usage")),
            earlier_by_key.get(_account_key(provider, model), UsageSnapshot()),
        )
        if usage.total_tokens or usage.cached_input_tokens:
            entries.append(_account_entry(provider, model, usage))

    return {
        "total": subtract_usage_snapshots(later_total, earlier_total).model_dump(mode="json"),
        "by_model": entries,
    }


class CostTracker:
    """Accumulate usage over the lifetime of a session."""

    def __init__(self) -> None:
        self._usage = UsageSnapshot()
        self._usage_by_model: dict[str, tuple[str, str, UsageSnapshot]] = {}

    def add(self, usage: UsageSnapshot, *, provider: str = "", model: str = "") -> None:
        """Add a usage snapshot to the running total."""
        self._usage = add_usage_snapshots(self._usage, usage)
        if not (usage.total_tokens or usage.cached_input_tokens):
            return
        provider_name = str(provider or "").strip()
        model_name = str(model or "").strip()
        key = _account_key(provider_name, model_name)
        _, _, existing = self._usage_by_model.get(key, (provider_name, model_name, UsageSnapshot()))
        self._usage_by_model[key] = (provider_name, model_name, add_usage_snapshots(existing, usage))

    def load(
        self,
        *,
        usage: UsageSnapshot | dict[str, Any] | None = None,
        accounting: dict[str, Any] | None = None,
        provider: str = "",
        model: str = "",
    ) -> None:
        """Replace the tracker state from persisted usage data."""
        self._usage = UsageSnapshot()
        self._usage_by_model = {}
        if isinstance(accounting, dict):
            self._usage = _coerce_usage(accounting.get("total"))
            for item in accounting.get("by_model", []):
                if not isinstance(item, dict):
                    continue
                item_provider = str(item.get("provider") or provider or "")
                item_model = str(item.get("model") or model or "")
                item_usage = _coerce_usage(item.get("usage"))
                if item_usage.total_tokens or item_usage.cached_input_tokens:
                    self._usage_by_model[_account_key(item_provider, item_model)] = (
                        item_provider,
                        item_model,
                        item_usage,
                    )
        if not (self._usage.total_tokens or self._usage.cached_input_tokens):
            self._usage = _coerce_usage(usage)
        if not self._usage_by_model and (self._usage.total_tokens or self._usage.cached_input_tokens):
            provider_name = str(provider or "").strip()
            model_name = str(model or "").strip()
            self._usage_by_model[_account_key(provider_name, model_name)] = (
                provider_name,
                model_name,
                self._usage,
            )

    @property
    def total(self) -> UsageSnapshot:
        """Return the aggregated usage."""
        return self._usage

    @property
    def accounting(self) -> dict[str, Any]:
        """Return model/provider usage buckets for persistence and cost estimates."""
        return {
            "total": self._usage.model_dump(mode="json"),
            "by_model": [
                _account_entry(provider, model, usage)
                for provider, model, usage in self._usage_by_model.values()
            ],
        }
