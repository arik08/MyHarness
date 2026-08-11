"""Ensure every configured MCP server has exactly one routed skill wrapper."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.skills.loader import load_skills_from_dirs
from myharness.skills.routing import is_mcp_routed_skill, mcp_server_name_from_skill_source


ROOT = Path(__file__).resolve().parents[2]


def test_every_configured_mcp_has_one_skill_wrapper():
    configured_servers = set(load_mcp_configs_from_dirs([ROOT / ".skills" / "mcp"]))
    skills = load_skills_from_dirs([ROOT / ".skills" / "mcp"])
    routed_servers = [
        mcp_server_name_from_skill_source(skill.source)
        for skill in skills
        if is_mcp_routed_skill(skill)
    ]
    wrapper_counts = Counter(routed_servers)

    assert set(wrapper_counts) == configured_servers
    assert all(count == 1 for count in wrapper_counts.values())
    assert all(len(skill.description) <= 180 for skill in skills if is_mcp_routed_skill(skill))


def test_mcp_wrappers_are_kept_out_of_general_skills():
    general_skills = load_skills_from_dirs([ROOT / ".skills" / "General"])

    assert all(not is_mcp_routed_skill(skill) for skill in general_skills)


def test_posco_placeholder_configs_are_repo_portable():
    configs = load_mcp_configs_from_dirs([ROOT / ".skills" / "mcp"])
    posco_configs = {
        name: config
        for name, config in configs.items()
        if name.startswith("posco-")
    }

    assert len(posco_configs) == 9
    for config in posco_configs.values():
        assert config.cwd == "."
        assert config.args[0] == "runtime/server.py"
        assert config.auto_connect is False
