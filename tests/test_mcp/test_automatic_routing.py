"""Regression coverage for discoverable MCP routes and truthful activation results."""

from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from myharness.config.settings import Settings
from myharness.mcp.availability import DUMMY_MCP_SERVERS, is_dummy_mcp
from myharness.mcp.client import McpClientManager
from myharness.mcp.config import load_mcp_server_configs
from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpConnectionStatus, McpToolInfo
from myharness.prompts.context import _build_skills_section
from myharness.skills.loader import load_skills_from_dirs
from myharness.skills.registry import SkillRegistry
from myharness.skills.routing import mcp_server_name_from_skill_source
from myharness.tools.base import ToolExecutionContext, ToolRegistry
from myharness.tools.skill_tool import SkillTool, SkillToolInput


ROOT = Path(__file__).resolve().parents[2]
SKILLS = load_skills_from_dirs([ROOT / ".skills" / "mcp"])


def test_dummy_configs_never_enter_runtime():
    configs = load_mcp_server_configs(Settings(), [])
    assert not DUMMY_MCP_SERVERS.intersection(configs)
    assert "company-disclosure" in configs


@pytest.mark.asyncio
@pytest.mark.parametrize("name", sorted(DUMMY_MCP_SERVERS))
async def test_dummy_never_attempts_transport_even_when_forced(name):
    config = load_mcp_configs_from_dirs([ROOT / ".skills" / "mcp"])[name]
    config = config.model_copy(update={"auto_connect": True})
    manager = McpClientManager({name: config})
    manager._connect_stdio = AsyncMock()
    manager._connect_http = AsyncMock()
    await manager.connect_all()
    await manager.ensure_server_config(name, config, force_connect=True)
    await manager._connect_one(name, config)
    await manager.reconnect_all()
    manager._connect_stdio.assert_not_called()
    manager._connect_http.assert_not_called()
    assert manager.list_statuses()[0].state == "disabled"
    assert manager.list_tools() == []


def test_every_packaged_mcp_is_discoverable_before_connection(tmp_path, monkeypatch):
    registry = SkillRegistry()
    for skill in SKILLS:
        registry.register(skill)
    monkeypatch.setattr("myharness.prompts.context.load_skill_registry", lambda *a, **kw: registry)
    configured = load_mcp_configs_from_dirs([ROOT / ".skills" / "mcp"])
    assert {mcp_server_name_from_skill_source(s.source) for s in SKILLS} == set(configured)
    section = _build_skills_section(tmp_path, settings=Settings())
    for skill in SKILLS:
        if is_dummy_mcp(mcp_server_name_from_skill_source(skill.source)):
            assert f'skill(name="{skill.name}")' not in section
            continue
        assert f'skill(name="{skill.name}")' in section
        assert skill.description in section
        assert skill.content not in section


@pytest.mark.asyncio
@pytest.mark.parametrize("skill", SKILLS, ids=lambda s: s.name)
async def test_packaged_skill_activates_its_declared_server(skill, tmp_path, monkeypatch):
    registry = SkillRegistry()
    registry.register(skill)
    monkeypatch.setattr("myharness.tools.skill_tool.load_skill_registry", lambda *a, **kw: registry)
    monkeypatch.setattr("myharness.tools.skill_tool.increment_skill_usage_count", lambda name: None)
    server_name = mcp_server_name_from_skill_source(skill.source)
    config = object()
    calls = []

    async def connect(name, supplied_config, *, force_connect):
        calls.append((name, supplied_config, force_connect))

    manager = SimpleNamespace(
        get_server_config=lambda name: config if name == server_name else None,
        ensure_server_config=connect,
        list_statuses=lambda: [McpConnectionStatus(
            name=server_name, state="connected",
            tools=[McpToolInfo(server_name=server_name, name="query", description="Query", input_schema={})],
        )],
    )
    tools = ToolRegistry()
    result = await SkillTool().execute(
        SkillToolInput(name=skill.name),
        ToolExecutionContext(cwd=tmp_path, metadata={"mcp_manager": manager, "tool_registry": tools}),
    )
    if is_dummy_mcp(server_name):
        assert result.is_error
        assert calls == []
        assert tools.get(f"mcp__{server_name}__query") is None
        return
    assert not result.is_error
    assert calls == [(server_name, config, True)]
    assert tools.get(f"mcp__{server_name}__query") is not None
    assert f"활성 MCP 서버: {server_name}" in result.output
    assert f"mcp__{server_name}__query" in result.output


def test_bundled_read_only_declarations_are_explicit_and_exclude_unknown_tools():
    configs = load_mcp_configs_from_dirs([ROOT / ".skills" / "mcp"])
    active = [config for name, config in configs.items() if not is_dummy_mcp(name)]
    assert len(active) == 14
    assert sum(len(config.read_only_tools) for config in active) == 76
    assert "vector_db" not in configs
    for config in active:
        assert config.read_only_tools
        assert "write_future_tool" not in config.read_only_tools
        assert len(config.read_only_tools) == len(set(config.read_only_tools))


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["no_manager", "no_config", "exception", "failed", "no_tools"])
async def test_activation_failure_is_not_reported_as_success(failure, tmp_path, monkeypatch):
    registry = SkillRegistry()
    skill = next(s for s in SKILLS if s.name == "company-disclosure")
    registry.register(skill)
    monkeypatch.setattr("myharness.tools.skill_tool.load_skill_registry", lambda *a, **kw: registry)
    monkeypatch.setattr("myharness.tools.skill_tool.increment_skill_usage_count", lambda name: None)

    async def connect(*args, **kwargs):
        if failure == "exception":
            raise RuntimeError("https://example.invalid?key=SECRET_TEST_KEY")

    manager = SimpleNamespace(
        get_server_config=lambda name: None if failure == "no_config" else object(),
        ensure_server_config=connect,
        list_statuses=lambda: [McpConnectionStatus(
            name="company-disclosure", state="failed" if failure == "failed" else "connected",
        )],
    )
    tools = ToolRegistry()
    result = await SkillTool().execute(
        SkillToolInput(name=skill.name),
        ToolExecutionContext(cwd=tmp_path, metadata={
            "mcp_manager": None if failure == "no_manager" else manager, "tool_registry": tools,
        }),
    )
    assert result.is_error
    assert skill.content in result.output
    assert "SECRET_TEST_KEY" not in result.output
    assert tools.get("mcp__company-disclosure__query") is None
