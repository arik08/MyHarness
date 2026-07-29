"""Ensure every configured MCP server has exactly one routed skill wrapper."""

from __future__ import annotations

from collections import Counter
from pathlib import Path

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.skills.loader import load_skills_from_dirs
from myharness.skills.routing import is_mcp_routed_skill, mcp_server_name_from_skill_source


ROOT = Path(__file__).resolve().parents[2]


def test_every_configured_mcp_has_one_skill_wrapper():
    configured_servers = set(load_mcp_configs_from_dirs([ROOT / ".mcp"]))
    skills = load_skills_from_dirs([ROOT / ".skills" / "General"])
    routed_servers = [
        mcp_server_name_from_skill_source(skill.source)
        for skill in skills
        if is_mcp_routed_skill(skill)
    ]
    wrapper_counts = Counter(routed_servers)

    assert set(wrapper_counts) == configured_servers
    assert all(count == 1 for count in wrapper_counts.values())
    assert all(len(skill.description) <= 180 for skill in skills if is_mcp_routed_skill(skill))
