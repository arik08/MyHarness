"""Tests for MCP config and tool adapters."""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

from myharness.config.settings import Settings
from myharness.mcp.config import load_mcp_configs_from_dirs, load_mcp_server_configs
from myharness.mcp.types import McpAuthConfig, McpResourceInfo, McpStdioServerConfig, McpToolInfo
from myharness.plugins.types import LoadedPlugin
from myharness.plugins.schemas import PluginManifest
from myharness.project_preferences import ProjectPreferences, save_project_preferences
from myharness.skills.loader import load_skills_from_dirs
from myharness.tools import create_default_tool_registry
from myharness.tools.base import ToolExecutionContext


@dataclass
class FakeMcpManager:
    tools: list[McpToolInfo]
    resources: list[McpResourceInfo]

    def list_tools(self):
        return self.tools

    def list_resources(self):
        return self.resources

    async def call_tool(self, server_name: str, tool_name: str, arguments: dict):
        return f"{server_name}:{tool_name}:{arguments['name']}"

    async def read_resource(self, server_name: str, uri: str):
        return f"{server_name}:{uri}"


def test_load_mcp_server_configs_merges_plugins():
    settings = Settings(
        mcp_servers={"local": McpStdioServerConfig(command="python", args=["server.py"])}
    )
    plugin = LoadedPlugin(
        manifest=PluginManifest(name="demo", version="1.0.0"),
        path=Path("/tmp/demo"),
        enabled=True,
        mcp_servers={"remote": McpStdioServerConfig(command="python", args=["remote.py"])},
    )

    servers = load_mcp_server_configs(settings, [plugin])

    assert "local" in servers
    assert "demo:remote" in servers


def test_load_mcp_server_configs_filters_disabled_servers():
    settings = Settings(
        mcp_servers={"local": McpStdioServerConfig(command="python", args=["server.py"])},
        disabled_mcp_servers={"local"},
    )

    servers = load_mcp_server_configs(settings, [])
    all_servers = load_mcp_server_configs(settings, [], include_disabled=True)

    assert "local" not in servers
    assert "local" in all_servers


def test_load_mcp_server_configs_filters_server_for_disabled_skill_wrapper(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setattr("myharness.mcp.config.get_program_mcp_dirs", lambda: [])
    skill_dir = tmp_path / ".skills" / "demo-search"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo-search\ndescription: Search through demo MCP.\n"
        "source: skill-mcp:demo\n---\n\nUse the demo MCP tools.\n",
        encoding="utf-8",
    )
    save_project_preferences(tmp_path, ProjectPreferences(disabled_skills=["demo-search"]))
    settings = Settings(
        mcp_servers={"demo": McpStdioServerConfig(command="python", args=["server.py"])}
    )

    servers = load_mcp_server_configs(settings, [], cwd=tmp_path)
    all_servers = load_mcp_server_configs(settings, [], cwd=tmp_path, include_disabled=True)

    assert "demo" not in servers
    assert "demo" in all_servers


def test_program_mcp_relative_cwd_stays_portable_with_source_base(tmp_path: Path):
    mcp_dir = tmp_path / ".mcp"
    mcp_dir.mkdir()
    (mcp_dir / "local-sqlite.json").write_text(
        """{
  "mcpServers": {
    "local_sqlite": {
      "type": "stdio",
      "command": "python",
      "args": [".mcp/local_sqlite_server.py"],
      "cwd": "."
    }
  }
}
""",
        encoding="utf-8",
    )

    servers = load_mcp_configs_from_dirs([mcp_dir])

    assert servers["local_sqlite"].cwd == "."
    assert servers["local_sqlite"]._cwd_base == str(tmp_path.resolve())


def test_packaged_mcp_relative_cwd_resolves_inside_module(tmp_path: Path):
    packages_dir = tmp_path / ".skills" / "mcp"
    package_dir = packages_dir / "demo"
    package_dir.mkdir(parents=True)
    (package_dir / "mcp.json").write_text(
        '{"mcpServers":{"demo":{"type":"stdio","command":"python",'
        '"args":["runtime/server.py"],"cwd":".","auto_connect":false}}}',
        encoding="utf-8",
    )

    servers = load_mcp_configs_from_dirs([packages_dir])

    assert servers["demo"]._cwd_base == str(package_dir.resolve())


def test_packaged_mcp_runtime_wins_while_user_credentials_are_preserved(tmp_path: Path, monkeypatch):
    packages_dir = tmp_path / ".skills" / "mcp"
    package_dir = packages_dir / "demo"
    package_dir.mkdir(parents=True)
    (package_dir / "mcp.json").write_text(
        '{"mcpServers":{"demo":{"type":"stdio","command":"python",'
        '"args":["runtime/server.py"],"cwd":".","auto_connect":false,'
        '"env":{"BUILTIN":"yes"}}}}',
        encoding="utf-8",
    )
    monkeypatch.setattr("myharness.mcp.config.get_program_mcp_dirs", lambda: [packages_dir])
    settings = Settings(
        mcp_servers={
            "demo": McpStdioServerConfig(
                command="python",
                args=[".mcp/old_server.py"],
                cwd=".",
                env={"OLD_TOKEN": "preserved"},
            )
        },
        mcp_auth={"demo": McpAuthConfig(env={"NEW_TOKEN": "overlay"})},
    )

    server = load_mcp_server_configs(settings, [], include_disabled=True)["demo"]

    assert server.args == ["runtime/server.py"]
    assert server.auto_connect is False
    assert server._cwd_base == str(package_dir.resolve())
    assert server.env == {
        "BUILTIN": "yes",
        "OLD_TOKEN": "preserved",
        "NEW_TOKEN": "overlay",
    }


def test_removed_package_is_not_resurrected_by_legacy_program_setting(monkeypatch):
    monkeypatch.setattr("myharness.mcp.config.get_program_mcp_dirs", lambda: [])
    settings = Settings(
        mcp_servers={
            "retired": McpStdioServerConfig(
                command="python",
                args=[".mcp/retired_server.py"],
                cwd=".",
            )
        }
    )

    assert "retired" not in load_mcp_server_configs(settings, [], include_disabled=True)


def test_deleting_one_package_removes_its_config_and_skill(tmp_path: Path):
    packages_dir = tmp_path / ".skills" / "mcp"
    package_dir = packages_dir / "demo"
    skill_dir = package_dir / "skills" / "demo"
    skill_dir.mkdir(parents=True)
    (package_dir / "mcp.json").write_text(
        '{"mcpServers":{"demo":{"type":"stdio","command":"python",'
        '"args":["runtime/server.py"],"cwd":".","auto_connect":false}}}',
        encoding="utf-8",
    )
    (skill_dir / "SKILL.md").write_text(
        "---\nname: demo\ndescription: Demo package\nsource: skill-mcp:demo\n---\n",
        encoding="utf-8",
    )

    assert "demo" in load_mcp_configs_from_dirs([packages_dir])
    assert [skill.name for skill in load_skills_from_dirs([packages_dir])] == ["demo"]

    shutil.rmtree(package_dir)

    assert "demo" not in load_mcp_configs_from_dirs([packages_dir])
    assert load_skills_from_dirs([packages_dir]) == []


def test_stdio_cwd_resolves_against_source_base(tmp_path: Path):
    config = McpStdioServerConfig(command="python", cwd=".")
    config._cwd_base = str(tmp_path)

    from myharness.mcp.client import _stdio_cwd

    assert _stdio_cwd(config) == str(tmp_path.resolve())


async def test_mcp_tools_are_registered():
    manager = FakeMcpManager(
        tools=[
            McpToolInfo(
                server_name="demo",
                name="hello",
                description="Say hello",
                input_schema={
                    "type": "object",
                    "properties": {"name": {"type": "string"}},
                    "required": ["name"],
                },
            )
        ],
        resources=[McpResourceInfo(server_name="demo", name="Readme", uri="demo://readme")],
    )
    registry = create_default_tool_registry(manager)

    tool = registry.get("mcp__demo__hello")
    assert tool is not None
    parsed = tool.input_model.model_validate({"name": "world"})
    result = await tool.execute(parsed, ToolExecutionContext(cwd=Path(".")))
    assert result.output == "demo:hello:world"

    list_tool = registry.get("list_mcp_resources")
    assert list_tool is not None
    list_result = await list_tool.execute(list_tool.input_model(), ToolExecutionContext(cwd=Path(".")))
    assert "demo://readme" in list_result.output
