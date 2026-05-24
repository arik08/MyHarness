import json
from pathlib import Path

from myharness.config.settings import Settings, save_settings, load_settings
from myharness.plugins import load_plugins
from myharness.project_preferences import (
    apply_project_preferences_to_settings,
    effective_project_preferences,
    get_app_preferences_path,
    get_project_preferences_path,
    load_app_preferences,
    save_project_preferences,
    set_project_mcp_enabled,
    set_project_plugin_enabled,
    set_project_skill_enabled,
    ProjectPreferences,
)
from myharness.skills import load_skill_registry


def test_project_preferences_fall_back_to_global_settings(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    save_settings(
        Settings(
            disabled_mcp_servers={"global-mcp"},
            enabled_plugins={"global-plugin": False},
        )
    )
    skill_state = tmp_path / "config" / "skill_state.json"
    skill_state.write_text(json.dumps({"disabled_skills": ["global-skill"]}), encoding="utf-8")

    preferences = effective_project_preferences(tmp_path / "workspace", load_settings())

    assert preferences.disabled_skills == ["global-skill"]
    assert preferences.disabled_mcp_servers == ["global-mcp"]
    assert preferences.enabled_plugins == {"global-plugin": False}


def test_project_preferences_overlay_settings(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    save_settings(
        Settings(
            disabled_mcp_servers={"global-mcp"},
            enabled_plugins={"global-plugin": False},
        )
    )
    workspace = tmp_path / "workspace"
    save_project_preferences(
        workspace,
        ProjectPreferences(
            disabled_mcp_servers=["project-mcp"],
            enabled_plugins={"project-plugin": True},
        ),
    )

    settings = apply_project_preferences_to_settings(load_settings(), workspace)

    assert settings.disabled_mcp_servers == {"project-mcp"}
    assert settings.enabled_plugins == {"global-plugin": False, "project-plugin": True}


def test_app_plugin_preference_applies_when_workspace_preference_is_empty(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    save_settings(Settings(enabled_plugins={"global-plugin": True}))
    workspace = tmp_path / "workspace"
    save_project_preferences(workspace, ProjectPreferences())
    get_app_preferences_path().write_text(
        json.dumps({
            "version": 1,
            "disabled_skills": [],
            "disabled_mcp_servers": [],
            "enabled_plugins": {"global-plugin": False},
        }),
        encoding="utf-8",
    )

    settings = apply_project_preferences_to_settings(load_settings(), workspace)

    assert settings.enabled_plugins == {"global-plugin": False}


def test_legacy_default_workspace_plugin_preference_applies_to_empty_workspace(tmp_path: Path, monkeypatch):
    config_dir = tmp_path / "repo" / ".myharness"
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(config_dir))
    legacy_preferences = tmp_path / "repo" / "Playground" / "shared" / "Default" / ".myharness" / "preferences.json"
    legacy_preferences.parent.mkdir(parents=True)
    legacy_preferences.write_text(
        json.dumps({
            "version": 1,
            "disabled_skills": [],
            "disabled_mcp_servers": [],
            "enabled_plugins": {"claude-for-legal-lite": False},
        }),
        encoding="utf-8",
    )
    workspace = tmp_path / "repo" / "Playground" / "127.0.0.1" / "Default"
    save_project_preferences(workspace, ProjectPreferences())

    settings = apply_project_preferences_to_settings(load_settings(), workspace)

    assert settings.enabled_plugins["claude-for-legal-lite"] is False


def test_project_toggle_writes_portable_json(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    save_settings(
        Settings(
            disabled_mcp_servers={"global-mcp"},
            enabled_plugins={"global-plugin": False},
        )
    )
    workspace = tmp_path / "workspace"
    settings = load_settings()

    set_project_skill_enabled(workspace, "Demo Skill", False, settings)
    set_project_mcp_enabled(workspace, "demo-mcp", False, settings)
    set_project_plugin_enabled(workspace, "demo-plugin", True, settings)

    payload = json.loads(get_project_preferences_path(workspace).read_text(encoding="utf-8"))
    assert payload == {
        "version": 1,
        "disabled_skills": ["demo skill"],
        "disabled_mcp_servers": ["demo-mcp", "global-mcp"],
        "enabled_plugins": {
            "demo-plugin": True,
            "global-plugin": False,
        },
    }


def test_plugin_toggle_can_reset_owned_skill_overrides(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    workspace = tmp_path / "workspace"
    settings = load_settings()

    set_project_skill_enabled(workspace, "Using-Superpowers", False, settings)
    set_project_plugin_enabled(
        workspace,
        "superpowers",
        False,
        settings,
        reset_skill_names=["using-superpowers", "writing-skills"],
    )

    payload = json.loads(get_project_preferences_path(workspace).read_text(encoding="utf-8"))
    assert payload == {
        "version": 1,
        "disabled_skills": [],
        "disabled_mcp_servers": [],
        "enabled_plugins": {"superpowers": False},
    }
    assert load_app_preferences().enabled_plugins == {"superpowers": False}


def test_project_plugin_disable_hides_owned_skills_on_reload(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    workspace = tmp_path / "workspace"
    plugin_dir = workspace / ".myharness" / "plugins" / "legal-lite"
    skill_dir = plugin_dir / "skills" / "legal-contract-review"
    skill_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(
        json.dumps(
            {
                "name": "claude-for-legal-lite",
                "version": "0.1.0",
                "description": "Legal review skills",
                "enabled_by_default": True,
                "skills_dir": "skills",
            }
        ),
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text(
        "---\nname: legal-contract-review\ndescription: Review contracts.\n---\n# Contract review\n",
        encoding="utf-8",
    )
    save_settings(Settings(allow_project_plugins=True))
    settings = load_settings()

    set_project_plugin_enabled(workspace, "claude-for-legal-lite", False, settings)
    effective = apply_project_preferences_to_settings(load_settings(), workspace)

    plugins = load_plugins(effective, workspace)
    skills = load_skill_registry(workspace, settings=effective, include_disabled=True).list_skills()

    assert plugins[0].enabled is False
    assert "legal-contract-review" not in {skill.name for skill in skills}
