"""Program-local POSCO demo skills."""

from __future__ import annotations

from pathlib import Path

from myharness.config.settings import Settings
from myharness.plugins import load_plugins
from myharness.skills import load_skill_registry


def test_program_local_posco_skill_loads_as_skill_only_plugin(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    project = tmp_path / "workspace"
    project.mkdir()
    plugins = load_plugins(Settings(), project, include_program_plugins=True)
    by_name = {plugin.manifest.name: plugin for plugin in plugins}

    assert not {
        "경영기획본부",
        "마케팅본부",
        "구매본부",
        "포항제철소",
        "광양제철소",
    } & set(by_name)

    plugin = by_name["POSCO 스킬"]
    assert plugin.enabled is True
    assert len(plugin.skills) == 11
    assert plugin.commands == []
    assert plugin.agents == []
    assert plugin.hooks == {}
    assert plugin.mcp_servers == {}
    assert plugin.tools == []

    skills = load_skill_registry(project, settings=Settings()).list_skills()
    skill_sources = {skill.name: skill.source for skill in skills}
    expected_names = [
        "경영 Skill",
        "안전보건환경본부",
        "사장직속",
        "경영기획본부",
        "전략투자본부",
        "경영지원본부",
        "마케팅본부",
        "구매본부",
        "포항제철소",
        "광양제철소",
        "기술연구원",
    ]
    assert {skill.name for skill in plugin.skills} == set(expected_names)
    for name in expected_names:
        assert skill_sources[name] == "plugin:POSCO 스킬"
