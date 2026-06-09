"""Persistent skill enablement state."""

from __future__ import annotations

import json
import threading
from dataclasses import replace
from pathlib import Path
from typing import Iterable

from myharness.config.paths import get_config_dir
from myharness.skills.types import SkillDefinition
from myharness.utils.fs import atomic_write_text


_USAGE_LOCK = threading.RLock()


def get_skill_state_path() -> Path:
    """Return the persistent skill state file path."""
    path = get_config_dir() / "skill_state.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def get_skill_usage_counts_path() -> Path:
    """Return the persistent global skill usage counter path."""
    path = get_config_dir() / "skill_usage_counts.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def get_disabled_skill_names() -> set[str]:
    """Return disabled skill names as normalized lowercase strings."""
    path = get_skill_state_path()
    if not path.exists():
        return set()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return set()
    names = payload.get("disabled_skills") if isinstance(payload, dict) else None
    if not isinstance(names, list):
        return set()
    return {_normalize_name(name) for name in names if _normalize_name(name)}


def is_skill_enabled(name: str) -> bool:
    """Return whether a skill is enabled by name."""
    normalized = _normalize_name(name)
    return not normalized or normalized not in get_disabled_skill_names()


def set_skill_enabled(name: str, enabled: bool) -> bool:
    """Persist skill enabled state. Returns the resulting enabled value."""
    normalized = _normalize_name(name)
    if not normalized:
        return True
    disabled = get_disabled_skill_names()
    if enabled:
        disabled.discard(normalized)
    else:
        disabled.add(normalized)
    _write_disabled_skill_names(disabled)
    return enabled


def toggle_skill_enabled(name: str) -> bool:
    """Toggle a skill enabled state. Returns the new enabled value."""
    enabled = not is_skill_enabled(name)
    return set_skill_enabled(name, enabled)


def apply_skill_enabled_state(
    skills: Iterable[SkillDefinition],
    disabled_skill_names: set[str] | None = None,
) -> list[SkillDefinition]:
    """Return skill definitions annotated with their persisted enabled state."""
    disabled = disabled_skill_names if disabled_skill_names is not None else get_disabled_skill_names()
    return [
        replace(skill, enabled=_normalize_name(skill.name) not in disabled)
        for skill in skills
    ]


def get_skill_usage_counts() -> dict[str, int]:
    """Return global skill usage counts keyed by normalized skill name."""
    path = get_skill_usage_counts_path()
    if not path.exists():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    counts = payload.get("usage_counts") if isinstance(payload, dict) else None
    if not isinstance(counts, dict):
        return {}
    normalized: dict[str, int] = {}
    for name, value in counts.items():
        normalized_name = _normalize_name(name)
        if not normalized_name:
            continue
        try:
            count = int(value)
        except (TypeError, ValueError):
            continue
        if count > 0:
            normalized[normalized_name] = count
    return dict(sorted(normalized.items()))


def get_skill_usage_count(name: str) -> int:
    """Return the global usage count for one skill name."""
    normalized = _normalize_name(name)
    if not normalized:
        return 0
    return get_skill_usage_counts().get(normalized, 0)


def increment_skill_usage_count(name: str) -> int:
    """Increment and persist the global usage count for one skill."""
    normalized = _normalize_name(name)
    if not normalized:
        return 0
    with _USAGE_LOCK:
        counts = get_skill_usage_counts()
        counts[normalized] = max(0, int(counts.get(normalized, 0))) + 1
        _write_skill_usage_counts(counts)
        return counts[normalized]


def _write_disabled_skill_names(disabled: set[str]) -> None:
    path = get_skill_state_path()
    payload = {"disabled_skills": sorted(name for name in disabled if name)}
    path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def _write_skill_usage_counts(counts: dict[str, int]) -> None:
    path = get_skill_usage_counts_path()
    cleaned = {
        _normalize_name(name): int(count)
        for name, count in counts.items()
        if _normalize_name(name) and int(count) > 0
    }
    payload = {
        "version": 1,
        "usage_counts": dict(sorted(cleaned.items())),
    }
    atomic_write_text(path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def _normalize_name(name: object) -> str:
    return str(name or "").strip().lower()
