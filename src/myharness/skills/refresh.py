"""Shared signal for refreshing skill discovery after a successful save."""

from __future__ import annotations

from pathlib import Path

SKILL_REGISTRY_DIRTY_KEY = "skill_registry_dirty"


def mark_skill_registry_dirty(metadata: dict[str, object], path: str | Path) -> None:
    """Mark the runtime skill catalog stale when a SKILL.md file was saved."""
    if Path(path).name.casefold() == "skill.md":
        metadata[SKILL_REGISTRY_DIRTY_KEY] = True


def consume_skill_registry_dirty(metadata: dict[str, object]) -> bool:
    """Consume and return the pending skill-catalog refresh signal."""
    return metadata.pop(SKILL_REGISTRY_DIRTY_KEY, False) is True
