"""Plugin skill loading."""

from __future__ import annotations

from pathlib import Path

from myharness.config.settings import Settings
from myharness.plugins import load_plugins


def test_plugin_skills_load_from_nested_department_dirs(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    project = tmp_path / "workspace"
    project.mkdir()
    plugin_dir = tmp_path / "plugins" / "POSCO 스킬"
    nested_skill_dir = plugin_dir / "skills" / "경영기획본부" / "전략 시나리오"
    nested_skill_dir.mkdir(parents=True)
    (plugin_dir / "plugin.json").write_text(
        '{"name":"POSCO 스킬","version":"1.0.0","description":"Real POSCO skills","skills_dir":"skills"}',
        encoding="utf-8",
    )
    (nested_skill_dir / "SKILL.md").write_text(
        "---\n"
        "name: \"전략 시나리오\"\n"
        "description: \"실제 경영기획본부 전략 시나리오 스킬입니다.\"\n"
        "---\n\n"
        "# 전략 시나리오\n",
        encoding="utf-8",
    )

    plugins = load_plugins(Settings(), project, extra_roots=[tmp_path / "plugins"])

    plugin = next(plugin for plugin in plugins if plugin.manifest.name == "POSCO 스킬")
    assert [skill.name for skill in plugin.skills] == ["전략 시나리오"]
    assert plugin.skills[0].source == "plugin:POSCO 스킬"
