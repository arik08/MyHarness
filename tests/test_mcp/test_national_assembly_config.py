"""Tests for the Korean National Assembly MCP connector config."""

from __future__ import annotations

from pathlib import Path

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig
from myharness.skills.loader import load_skills_from_dirs


def test_national_assembly_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["national-assembly"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/national_assembly_bootstrap.py"]
    assert server.cwd == "."
    assert server.env == {
        "ASSEMBLY_API_KEY": "8b90dd60d8484b0eb9d369ee8a324149",
        "LAWMKING_OC": "arik08",
        "MCP_PROFILE": "full",
        "MCP_TRANSPORT": "stdio",
    }


def test_national_assembly_skill_is_mcp_routed() -> None:
    skills_dir = Path(__file__).resolve().parents[2] / ".skills"

    skills = {skill.name: skill for skill in load_skills_from_dirs([skills_dir], source="project")}

    skill = skills["national-assembly"]
    assert skill.source == "skill-mcp:national-assembly"
    assert "열린국회정보" in skill.description
