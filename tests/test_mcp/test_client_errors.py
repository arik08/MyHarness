"""Tests for MCP client error handling on disconnected servers."""

from __future__ import annotations

from pathlib import Path
import asyncio
from contextlib import AsyncExitStack
from unittest.mock import AsyncMock, MagicMock

import pytest

from myharness.mcp.client import McpClientManager, McpServerNotConnectedError
from myharness.mcp.types import McpConnectionStatus, McpStdioServerConfig, McpToolInfo
from myharness.tools.base import ToolExecutionContext
from myharness.tools.mcp_tool import McpToolAdapter
from myharness.tools.read_mcp_resource_tool import ReadMcpResourceTool


# --- McpClientManager.call_tool ---


@pytest.mark.asyncio
async def test_call_tool_raises_when_server_never_connected():
    manager = McpClientManager({})
    with pytest.raises(McpServerNotConnectedError, match="not connected"):
        await manager.call_tool("missing", "some_tool", {})


@pytest.mark.asyncio
async def test_call_tool_raises_when_server_failed_to_connect():
    config = McpStdioServerConfig(command="false", args=[])
    manager = McpClientManager({"bad": config})
    manager._statuses["bad"] = McpConnectionStatus(
        name="bad", state="failed", detail="Connection refused",
    )
    with pytest.raises(McpServerNotConnectedError, match="Connection refused"):
        await manager.call_tool("bad", "tool", {})


@pytest.mark.asyncio
async def test_call_tool_raises_when_session_errors():
    manager = McpClientManager({})
    mock_session = AsyncMock()
    mock_session.call_tool.side_effect = RuntimeError("transport closed")
    manager._sessions["flaky"] = mock_session

    with pytest.raises(McpServerNotConnectedError, match="transport closed"):
        await manager.call_tool("flaky", "tool", {})


@pytest.mark.asyncio
async def test_call_tool_includes_unknown_server_detail_for_unconfigured():
    """When the server name is not even in _statuses, detail says 'unknown server'."""
    manager = McpClientManager({})
    with pytest.raises(McpServerNotConnectedError, match="unknown server"):
        await manager.call_tool("ghost", "tool", {})


# --- McpClientManager.read_resource ---


@pytest.mark.asyncio
async def test_read_resource_raises_when_server_never_connected():
    manager = McpClientManager({})
    with pytest.raises(McpServerNotConnectedError, match="not connected"):
        await manager.read_resource("missing", "res://data")


@pytest.mark.asyncio
async def test_read_resource_raises_when_session_errors():
    manager = McpClientManager({})
    mock_session = AsyncMock()
    mock_session.read_resource.side_effect = OSError("broken pipe")
    manager._sessions["flaky"] = mock_session

    with pytest.raises(McpServerNotConnectedError, match="broken pipe"):
        await manager.read_resource("flaky", "res://data")


@pytest.mark.asyncio
async def test_register_connected_session_tolerates_missing_resources_list():
    manager = McpClientManager({})
    session = AsyncMock()
    session.initialize.return_value = None
    session.list_tools.return_value.tools = []
    session.list_resources.side_effect = RuntimeError("Method not found")
    stack = AsyncExitStack()
    await stack.__aenter__()
    stack.enter_async_context = AsyncMock(return_value=session)

    await manager._register_connected_session(
        name="context7",
        config=McpStdioServerConfig(command="npx", args=[]),
        stack=stack,
        read_stream=object(),
        write_stream=object(),
        auth_configured=False,
    )

    assert manager._statuses["context7"].state == "connected"
    assert manager._statuses["context7"].resources == []


@pytest.mark.asyncio
async def test_connect_all_connects_servers_concurrently(monkeypatch):
    manager = McpClientManager(
        {
            "first": McpStdioServerConfig(command="python", args=[]),
            "second": McpStdioServerConfig(command="python", args=[]),
        }
    )
    started: list[str] = []
    release = asyncio.Event()

    async def _connect_stdio(name, _config):
        started.append(name)
        if len(started) == 2:
            release.set()
        await asyncio.wait_for(release.wait(), timeout=1)
        manager._statuses[name] = McpConnectionStatus(name=name, state="connected", transport="stdio")

    monkeypatch.setattr(manager, "_connect_stdio", _connect_stdio)

    await manager.connect_all()

    assert set(started) == {"first", "second"}
    assert all(status.state == "connected" for status in manager.list_statuses())


@pytest.mark.asyncio
async def test_force_connect_retries_an_unchanged_failed_server(monkeypatch):
    config = McpStdioServerConfig(command="python", args=[])
    manager = McpClientManager({"retry": config})
    manager._statuses["retry"] = McpConnectionStatus(
        name="retry",
        state="failed",
        transport="stdio",
        detail="temporary startup failure",
    )
    connect = AsyncMock()
    monkeypatch.setattr(manager, "_connect_stdio", connect)

    changed = await manager.ensure_server_config("retry", config, force_connect=True)

    assert changed is True
    connect.assert_awaited_once_with("retry", config)


@pytest.mark.asyncio
async def test_connect_stdio_merges_parent_environment(monkeypatch):
    captured = {}

    class _StdioContext:
        async def __aenter__(self):
            return object(), object()

        async def __aexit__(self, *_args):
            return None

    def _stdio_client(parameters):
        captured["parameters"] = parameters
        return _StdioContext()

    manager = McpClientManager({})
    manager._register_connected_session = AsyncMock()
    monkeypatch.setattr("myharness.mcp.client.stdio_client", _stdio_client)
    monkeypatch.setenv("NODE_EXTRA_CA_CERTS", "company-ca.pem")
    monkeypatch.setenv("HTTPS_PROXY", "http://company-proxy")

    await manager._connect_stdio(
        "assembly",
        McpStdioServerConfig(
            command="node",
            args=["dist/index.js"],
            env={"HTTPS_PROXY": "http://server-specific-proxy", "MCP_PROFILE": "full"},
        ),
    )

    child_env = captured["parameters"].env
    assert child_env["NODE_EXTRA_CA_CERTS"] == "company-ca.pem"
    assert child_env["HTTPS_PROXY"] == "http://server-specific-proxy"
    assert child_env["MCP_PROFILE"] == "full"


@pytest.mark.asyncio
async def test_close_suppresses_known_runtime_error_from_stdio_cleanup():
    manager = McpClientManager({})
    stack = MagicMock()
    stack.aclose = AsyncMock(side_effect=RuntimeError("Attempted to exit cancel scope in a different task than it was entered in"))
    manager._stacks["context7"] = stack
    manager._sessions["context7"] = AsyncMock()

    await manager.close()

    assert manager._stacks == {}
    assert manager._sessions == {}


@pytest.mark.asyncio
async def test_close_suppresses_cancelled_error_from_stdio_cleanup():
    manager = McpClientManager({})
    stack = MagicMock()
    stack.aclose = AsyncMock(side_effect=asyncio.CancelledError())
    manager._stacks["context7"] = stack
    manager._sessions["context7"] = AsyncMock()

    await manager.close()

    assert manager._stacks == {}
    assert manager._sessions == {}


@pytest.mark.asyncio
async def test_close_unwinds_mcp_stacks_in_reverse_connection_order():
    manager = McpClientManager({})
    closed: list[str] = []

    def stack(name: str):
        value = MagicMock()

        async def close() -> None:
            closed.append(name)

        value.aclose = close
        return value

    manager._stacks = {"first": stack("first"), "second": stack("second")}

    await manager.close()

    assert closed == ["second", "first"]


# --- McpToolAdapter catches error and returns ToolResult(is_error=True) ---


@pytest.mark.asyncio
async def test_mcp_tool_adapter_returns_error_result_on_disconnected_server():
    manager = McpClientManager({})
    tool_info = McpToolInfo(
        server_name="gone",
        name="hello",
        description="test",
        input_schema={"type": "object", "properties": {"x": {"type": "string"}}},
    )
    adapter = McpToolAdapter(manager, tool_info)
    result = await adapter.execute(
        adapter.input_model.model_validate({"x": "1"}),
        ToolExecutionContext(cwd=Path(".")),
    )
    assert result.is_error is True
    assert "not connected" in result.output


# --- ReadMcpResourceTool catches error and returns ToolResult(is_error=True) ---


@pytest.mark.asyncio
async def test_read_mcp_resource_tool_returns_error_result_on_disconnected_server():
    manager = McpClientManager({})
    tool = ReadMcpResourceTool(manager)
    result = await tool.execute(
        tool.input_model.model_validate({"server": "gone", "uri": "res://x"}),
        ToolExecutionContext(cwd=Path(".")),
    )
    assert result.is_error is True
    assert "not connected" in result.output
