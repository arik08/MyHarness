"""Shared signal for refreshing skill discovery after a successful save."""

from __future__ import annotations

from pathlib import Path
from typing import Iterable

SKILL_REGISTRY_DIRTY_KEY = "skill_registry_dirty"


def mark_skill_registry_dirty(metadata: dict[str, object], path: str | Path) -> None:
    """Mark the runtime skill catalog stale when a SKILL.md file was saved."""
    if Path(path).name.casefold() == "skill.md":
        metadata[SKILL_REGISTRY_DIRTY_KEY] = True


def consume_skill_registry_dirty(metadata: dict[str, object]) -> bool:
    """Consume and return the pending skill-catalog refresh signal."""
    return metadata.pop(SKILL_REGISTRY_DIRTY_KEY, False) is True


def get_skill_watch_roots(
    cwd: str | Path,
    *,
    extra_skill_dirs: Iterable[str | Path] | None = None,
    extra_plugin_roots: Iterable[str | Path] | None = None,
) -> list[Path]:
    """Return existing roots whose SKILL.md changes affect runtime discovery."""
    from myharness.plugins.loader import (
        get_program_plugins_dirs,
        get_project_plugins_dir,
        get_user_plugins_dir,
    )
    from myharness.skills.loader import (
        get_program_skills_dirs,
        get_project_skills_dir,
        get_user_skills_dir,
    )

    candidates: list[str | Path] = [
        get_user_skills_dir(),
        get_project_skills_dir(cwd),
        *get_program_skills_dirs(),
        get_user_plugins_dir(),
        get_project_plugins_dir(cwd),
        *get_program_plugins_dirs(),
        *(extra_skill_dirs or []),
        *(extra_plugin_roots or []),
    ]
    roots: list[Path] = []
    seen: set[Path] = set()
    for candidate in candidates:
        root = Path(candidate).expanduser().resolve()
        if root in seen or not root.exists():
            continue
        seen.add(root)
        roots.append(root)
    return roots


def is_skill_catalog_change(path: str | Path) -> bool:
    """Return whether a changed file can add, remove, or update a skill."""
    name = Path(path).name.casefold()
    return name in {"skill.md", "plugin.json"}
