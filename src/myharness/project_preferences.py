"""Project-local UI preference storage."""

from __future__ import annotations

import threading
from pathlib import Path
from typing import Any, Iterable

from pydantic import BaseModel, Field

from myharness.config.paths import get_config_dir, get_project_config_dir
from myharness.config.settings import Settings
from myharness.skills.state import get_disabled_skill_names
from myharness.utils.file_lock import exclusive_file_lock
from myharness.utils.fs import atomic_write_text


_PREFERENCES_LOCK = threading.RLock()


class ProjectPreferences(BaseModel):
    """Portable project-local enablement preferences."""

    version: int = 1
    disabled_skills: list[str] = Field(default_factory=list)
    disabled_mcp_servers: list[str] = Field(default_factory=list)
    enabled_plugins: dict[str, bool] = Field(default_factory=dict)


def get_project_preferences_path(cwd: str | Path) -> Path:
    """Return the project-local preferences path."""
    return get_project_config_dir(cwd) / "preferences.json"


def get_app_preferences_path() -> Path:
    """Return app-wide capability preferences shared across workspaces."""
    return get_config_dir() / "preferences.json"


def load_project_preferences(cwd: str | Path) -> ProjectPreferences | None:
    """Load project-local preferences if present."""
    path = get_project_preferences_path(cwd)
    if not path.exists():
        return None
    try:
        raw = path.read_text(encoding="utf-8")
        return normalize_project_preferences(ProjectPreferences.model_validate_json(raw))
    except Exception:
        return None


def load_app_preferences() -> ProjectPreferences | None:
    """Load app-wide preferences if present."""
    path = get_app_preferences_path()
    if not path.exists():
        return _load_legacy_default_workspace_preferences()
    try:
        raw = path.read_text(encoding="utf-8")
        return normalize_project_preferences(ProjectPreferences.model_validate_json(raw))
    except Exception:
        return None


def preferences_from_global(settings: Settings) -> ProjectPreferences:
    """Build project preferences from the legacy global settings files."""
    return normalize_project_preferences(
        ProjectPreferences(
            disabled_skills=sorted(get_disabled_skill_names()),
            disabled_mcp_servers=sorted(settings.disabled_mcp_servers or set()),
            enabled_plugins=dict(settings.enabled_plugins or {}),
        )
    )


def effective_project_preferences(cwd: str | Path, settings: Settings) -> ProjectPreferences:
    """Return project preferences or the legacy global fallback."""
    return load_project_preferences(cwd) or preferences_from_global(settings)


def apply_project_preferences_to_settings(settings: Settings, cwd: str | Path | None) -> Settings:
    """Overlay project-local MCP and plugin preferences onto settings."""
    app_preferences = load_app_preferences()
    project_preferences = load_project_preferences(cwd) if cwd is not None else None
    if app_preferences is None and project_preferences is None:
        return settings
    enabled_plugins = dict(settings.enabled_plugins or {})
    if app_preferences is not None:
        enabled_plugins.update(app_preferences.enabled_plugins)
    if project_preferences is not None:
        enabled_plugins.update(project_preferences.enabled_plugins)
    disabled_mcp_servers = (
        set(project_preferences.disabled_mcp_servers)
        if project_preferences is not None
        else set(settings.disabled_mcp_servers or set())
    )
    return settings.model_copy(
        update={
            "disabled_mcp_servers": disabled_mcp_servers,
            "enabled_plugins": enabled_plugins,
        }
    )


def save_project_preferences(cwd: str | Path, preferences: ProjectPreferences) -> ProjectPreferences:
    """Persist normalized project preferences."""
    path = get_project_preferences_path(cwd)
    with _PREFERENCES_LOCK, exclusive_file_lock(_preferences_lock_path(path)):
        return _save_preferences(path, preferences)


def _save_preferences(path: Path, preferences: ProjectPreferences) -> ProjectPreferences:
    normalized = normalize_project_preferences(preferences)
    payload = normalized.model_dump_json(indent=2) + "\n"
    atomic_write_text(path, payload)
    return normalized


def save_app_preferences(preferences: ProjectPreferences) -> ProjectPreferences:
    """Persist normalized app-wide preferences."""
    path = get_app_preferences_path()
    with _PREFERENCES_LOCK, exclusive_file_lock(_preferences_lock_path(path)):
        return _save_preferences(path, preferences)


def _preferences_lock_path(path: Path) -> Path:
    return path.with_suffix(path.suffix + ".lock")


def _load_legacy_default_workspace_preferences() -> ProjectPreferences | None:
    """Recover app-wide plugin choices from older default workspace files."""
    playground = get_config_dir().parent / "Playground"
    if not playground.exists():
        return None
    merged = ProjectPreferences()
    found = False
    for path in sorted(playground.glob("*/Default/.myharness/preferences.json")):
        try:
            raw = path.read_text(encoding="utf-8")
            preferences = normalize_project_preferences(ProjectPreferences.model_validate_json(raw))
        except Exception:
            continue
        if preferences.enabled_plugins:
            merged.enabled_plugins.update(preferences.enabled_plugins)
            found = True
    return normalize_project_preferences(merged) if found else None


def set_project_skill_enabled(cwd: str | Path, name: str, enabled: bool, settings: Settings) -> ProjectPreferences:
    """Persist one skill enablement value in project preferences."""
    path = get_project_preferences_path(cwd)
    with _PREFERENCES_LOCK, exclusive_file_lock(_preferences_lock_path(path)):
        normalized_name = _normalize_name(name)
        preferences = effective_project_preferences(cwd, settings)
        disabled = {_normalize_name(item) for item in preferences.disabled_skills if _normalize_name(item)}
        if enabled:
            disabled.discard(normalized_name)
        elif normalized_name:
            disabled.add(normalized_name)
        preferences.disabled_skills = sorted(disabled)
        return _save_preferences(path, preferences)


def set_project_mcp_enabled(cwd: str | Path, name: str, enabled: bool, settings: Settings) -> ProjectPreferences:
    """Persist one MCP enablement value in project preferences."""
    path = get_project_preferences_path(cwd)
    with _PREFERENCES_LOCK, exclusive_file_lock(_preferences_lock_path(path)):
        preferences = effective_project_preferences(cwd, settings)
        disabled = {str(item).strip() for item in preferences.disabled_mcp_servers if str(item).strip()}
        clean_name = str(name or "").strip()
        if enabled:
            disabled.discard(clean_name)
        elif clean_name:
            disabled.add(clean_name)
        preferences.disabled_mcp_servers = sorted(disabled)
        return _save_preferences(path, preferences)


def set_project_plugin_enabled(
    cwd: str | Path,
    name: str,
    enabled: bool,
    settings: Settings,
    *,
    reset_skill_names: Iterable[str] | None = None,
) -> ProjectPreferences:
    """Persist one plugin enablement value in project preferences."""
    clean_name = str(name or "").strip()
    project_path = get_project_preferences_path(cwd)
    with _PREFERENCES_LOCK, exclusive_file_lock(_preferences_lock_path(project_path)):
        preferences = effective_project_preferences(cwd, settings)
        if clean_name:
            preferences.enabled_plugins[clean_name] = bool(enabled)
        reset_names = {
            _normalize_name(skill_name)
            for skill_name in reset_skill_names or ()
            if _normalize_name(skill_name)
        }
        if reset_names:
            preferences.disabled_skills = [
                skill_name
                for skill_name in preferences.disabled_skills
                if _normalize_name(skill_name) not in reset_names
            ]
        saved = _save_preferences(project_path, preferences)
    app_path = get_app_preferences_path()
    with _PREFERENCES_LOCK, exclusive_file_lock(_preferences_lock_path(app_path)):
        app_preferences = load_app_preferences() or ProjectPreferences()
        if clean_name:
            app_preferences.enabled_plugins[clean_name] = bool(enabled)
        _save_preferences(app_path, app_preferences)
    return saved


def normalize_project_preferences(preferences: ProjectPreferences) -> ProjectPreferences:
    """Return v1 preferences with stable ordering and only known fields."""
    return ProjectPreferences(
        version=1,
        disabled_skills=sorted({_normalize_name(name) for name in preferences.disabled_skills if _normalize_name(name)}),
        disabled_mcp_servers=sorted({str(name).strip() for name in preferences.disabled_mcp_servers if str(name).strip()}),
        enabled_plugins={
            str(name).strip(): bool(value)
            for name, value in sorted((preferences.enabled_plugins or {}).items())
            if str(name).strip()
        },
    )


def _normalize_name(name: Any) -> str:
    return str(name or "").strip().lower()
