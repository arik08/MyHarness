"""Program-local demo business plugins."""

from __future__ import annotations

from pathlib import Path

from myharness.config.settings import Settings
from myharness.plugins import load_plugins
from myharness.skills import load_skill_registry


def test_program_local_demo_business_plugins_load_as_skill_only_plugins(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))

    project = tmp_path / "workspace"
    project.mkdir()
    plugins = load_plugins(Settings(), project, include_program_plugins=True)
    by_name = {plugin.manifest.name: plugin for plugin in plugins}

    assert not {
        "경영기획",
        "지속가능경영",
        "투자관리",
        "사업관리",
        "재무관리",
        "산업가스",
    } & set(by_name)

    plugin = by_name["경영기획본부"]
    assert plugin.enabled is True
    assert len(plugin.skills) == 21
    assert plugin.commands == []
    assert plugin.agents == []
    assert plugin.hooks == {}
    assert plugin.mcp_servers == {}
    assert plugin.tools == []

    skills = load_skill_registry(project, settings=Settings()).list_skills()
    skill_sources = {skill.name: skill.source for skill in skills}
    assert skill_sources["경영기획-전략-시나리오"] == "plugin:경영기획본부"
    assert skill_sources["재무관리-재무기획"] == "plugin:경영기획본부"
    assert skill_sources["재무관리-원가전망"] == "plugin:경영기획본부"
    assert skill_sources["산업가스-사업개발"] == "plugin:경영기획본부"
    assert skill_sources["산업가스-마케팅"] == "plugin:경영기획본부"
    assert skill_sources["산업가스-조업안전기술"] == "plugin:경영기획본부"
