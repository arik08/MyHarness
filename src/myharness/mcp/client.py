"""MCP client manager."""

from __future__ import annotations

import asyncio
import contextlib
import inspect
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
try:
    from mcp.client.streamable_http import streamable_http_client
except ImportError:  # mcp <= 1.12 exposes the helper without the extra underscore.
    from mcp.client.streamable_http import streamablehttp_client as streamable_http_client
from mcp.types import CallToolResult, ReadResourceResult

from myharness.mcp.types import (
    McpConnectionStatus,
    McpHttpServerConfig,
    McpResourceInfo,
    McpStdioServerConfig,
    McpToolInfo,
)


class McpServerNotConnectedError(Exception):
    """Raised when an MCP server is not connected or its session has been lost."""


def _stdio_cwd(config: McpStdioServerConfig) -> str | None:
    if not config.cwd:
        return None
    cwd = Path(config.cwd).expanduser()
    if cwd.is_absolute():
        return str(cwd)
    cwd_base = getattr(config, "_cwd_base", None)
    if cwd_base:
        return str((Path(cwd_base).expanduser() / cwd).resolve())
    return config.cwd


class McpClientManager:
    """Manage MCP connections and expose tools/resources."""

    def __init__(self, server_configs: dict[str, object]) -> None:
        self._server_configs = server_configs
        self._statuses: dict[str, McpConnectionStatus] = {
            name: McpConnectionStatus(
                name=name,
                state="pending",
                transport=getattr(config, "type", "unknown"),
            )
            for name, config in server_configs.items()
        }
        self._sessions: dict[str, ClientSession] = {}
        self._stacks: dict[str, AsyncExitStack] = {}

    async def connect_all(self) -> None:
        """Connect all configured MCP servers supported by the current build."""
        for name, config in self._server_configs.items():
            if getattr(config, "auto_connect", True) is False:
                self._statuses[name] = McpConnectionStatus(
                    name=name,
                    state="pending",
                    transport=getattr(config, "type", "unknown"),
                    auth_configured=bool(getattr(config, "headers", None)),
                    detail="Configured; automatic connection is disabled.",
                )
                continue
            if isinstance(config, McpStdioServerConfig):
                await self._connect_stdio(name, config)
            elif isinstance(config, McpHttpServerConfig):
                await self._connect_http(name, config)
            else:
                self._statuses[name] = McpConnectionStatus(
                    name=name,
                    state="failed",
                    transport=config.type,
                    auth_configured=bool(getattr(config, "headers", None)),
                    detail=f"Unsupported MCP transport in current build: {config.type}",
                )

    async def reconnect_all(self) -> None:
        """Reconnect all configured servers."""
        await self.close()
        self._statuses = {
            name: McpConnectionStatus(name=name, state="pending", transport=getattr(config, "type", "unknown"))
            for name, config in self._server_configs.items()
        }
        await self.connect_all()

    def update_server_config(self, name: str, config: object) -> None:
        """Replace one server config in memory."""
        self._server_configs[name] = config

    def get_server_config(self, name: str) -> object | None:
        """Return one configured server object if present."""
        return self._server_configs.get(name)

    async def ensure_server_config(self, name: str, config: object, *, force_connect: bool = False) -> bool:
        """Add or refresh one server config and connect it if needed."""
        existing = self._server_configs.get(name)
        status = self._statuses.get(name)
        if existing == config and status is not None and status.state != "pending":
            return False
        if name in self._stacks:
            with contextlib.suppress(RuntimeError, asyncio.CancelledError):
                await self._stacks.pop(name).aclose()
            self._sessions.pop(name, None)
        self._server_configs[name] = config
        self._statuses[name] = McpConnectionStatus(
            name=name,
            state="pending",
            transport=getattr(config, "type", "unknown"),
        )
        if getattr(config, "auto_connect", True) is False and not force_connect:
            self._statuses[name] = McpConnectionStatus(
                name=name,
                state="pending",
                transport=getattr(config, "type", "unknown"),
                auth_configured=bool(getattr(config, "headers", None)),
                detail="Configured; automatic connection is disabled.",
            )
            return True
        if isinstance(config, McpStdioServerConfig):
            await self._connect_stdio(name, config)
        elif isinstance(config, McpHttpServerConfig):
            await self._connect_http(name, config)
        else:
            self._statuses[name] = McpConnectionStatus(
                name=name,
                state="failed",
                transport=getattr(config, "type", "unknown"),
                auth_configured=bool(getattr(config, "headers", None)),
                detail=f"Unsupported MCP transport in current build: {getattr(config, 'type', 'unknown')}",
            )
        return True

    async def close(self) -> None:
        """Close all active MCP sessions."""
        for stack in list(self._stacks.values()):
            with contextlib.suppress(RuntimeError, asyncio.CancelledError):
                await stack.aclose()
        self._stacks.clear()
        self._sessions.clear()

    def list_statuses(self) -> list[McpConnectionStatus]:
        """Return statuses for all configured servers."""
        return [self._statuses[name] for name in sorted(self._statuses)]

    def list_tools(self) -> list[McpToolInfo]:
        """Return all connected MCP tools."""
        tools: list[McpToolInfo] = []
        for status in self.list_statuses():
            tools.extend(status.tools)
        return tools

    def list_resources(self) -> list[McpResourceInfo]:
        """Return all connected MCP resources."""
        resources: list[McpResourceInfo] = []
        for status in self.list_statuses():
            resources.extend(status.resources)
        return resources

    async def call_tool(self, server_name: str, tool_name: str, arguments: dict[str, Any]) -> str:
        """Invoke one MCP tool and stringify the result."""
        session = self._sessions.get(server_name)
        if session is None:
            status = self._statuses.get(server_name)
            detail = status.detail if status else "unknown server"
            raise McpServerNotConnectedError(
                f"MCP server '{server_name}' is not connected: {detail}"
            )
        try:
            result: CallToolResult = await session.call_tool(tool_name, arguments)
        except Exception as exc:
            raise McpServerNotConnectedError(
                f"MCP server '{server_name}' call failed: {exc}"
            ) from exc
        parts: list[str] = []
        for item in result.content:
            if getattr(item, "type", None) == "text":
                parts.append(getattr(item, "text", ""))
            else:
                parts.append(item.model_dump_json())
        if result.structuredContent and not parts:
            parts.append(str(result.structuredContent))
        if not parts:
            parts.append("(no output)")
        return "\n".join(parts).strip()

    async def read_resource(self, server_name: str, uri: str) -> str:
        """Read one MCP resource and stringify the response."""
        session = self._sessions.get(server_name)
        if session is None:
            status = self._statuses.get(server_name)
            detail = status.detail if status else "unknown server"
            raise McpServerNotConnectedError(
                f"MCP server '{server_name}' is not connected: {detail}"
            )
        try:
            result: ReadResourceResult = await session.read_resource(uri)
        except Exception as exc:
            raise McpServerNotConnectedError(
                f"MCP server '{server_name}' resource read failed: {exc}"
            ) from exc
        parts: list[str] = []
        for item in result.contents:
            text = getattr(item, "text", None)
            if text is not None:
                parts.append(text)
            else:
                parts.append(str(getattr(item, "blob", "")))
        return "\n".join(parts).strip()

    async def _connect_stdio(self, name: str, config: McpStdioServerConfig) -> None:
        stack = AsyncExitStack()
        try:
            read_stream, write_stream = await stack.enter_async_context(
                stdio_client(
                    StdioServerParameters(
                        command=config.command,
                        args=config.args,
                        env=config.env,
                        cwd=_stdio_cwd(config),
                    )
                )
            )
            await self._register_connected_session(
                name=name,
                config=config,
                stack=stack,
                read_stream=read_stream,
                write_stream=write_stream,
                auth_configured=bool(config.env),
            )
        except Exception as exc:
            await stack.aclose()
            self._statuses[name] = McpConnectionStatus(
                name=name,
                state="failed",
                transport=config.type,
                auth_configured=bool(config.env),
                detail=str(exc),
            )

    async def _connect_http(self, name: str, config: McpHttpServerConfig) -> None:
        stack = AsyncExitStack()
        try:
            if "http_client" in inspect.signature(streamable_http_client).parameters:
                http_client = await stack.enter_async_context(
                    httpx.AsyncClient(headers=config.headers or None)
                )
                read_stream, write_stream, _get_session_id = await stack.enter_async_context(
                    streamable_http_client(config.url, http_client=http_client)
                )
            else:
                def _httpx_client_factory(**kwargs: Any) -> httpx.AsyncClient:
                    return httpx.AsyncClient(**kwargs)

                read_stream, write_stream, _get_session_id = await stack.enter_async_context(
                    streamable_http_client(
                        config.url,
                        headers=config.headers or None,
                        httpx_client_factory=_httpx_client_factory,
                    )
                )
            await self._register_connected_session(
                name=name,
                config=config,
                stack=stack,
                read_stream=read_stream,
                write_stream=write_stream,
                auth_configured=bool(config.headers),
            )
        except Exception as exc:
            await stack.aclose()
            self._statuses[name] = McpConnectionStatus(
                name=name,
                state="failed",
                transport=config.type,
                auth_configured=bool(config.headers),
                detail=str(exc),
            )

    async def _register_connected_session(
        self,
        *,
        name: str,
        config: object,
        stack: AsyncExitStack,
        read_stream: Any,
        write_stream: Any,
        auth_configured: bool,
    ) -> None:
        session = await stack.enter_async_context(ClientSession(read_stream, write_stream))
        await session.initialize()
        tool_result = await session.list_tools()
        resource_result = None
        try:
            resource_result = await session.list_resources()
        except Exception as exc:
            if "Method not found" not in str(exc):
                raise
        tools = [
            McpToolInfo(
                server_name=name,
                name=tool.name,
                description=tool.description or "",
                input_schema=dict(tool.inputSchema or {"type": "object", "properties": {}}),
            )
            for tool in tool_result.tools
        ]
        resources = [
            McpResourceInfo(
                server_name=name,
                name=resource.name or str(resource.uri),
                uri=str(resource.uri),
                description=resource.description or "",
            )
            for resource in (resource_result.resources if resource_result is not None else [])
        ]
        self._sessions[name] = session
        self._stacks[name] = stack
        self._statuses[name] = McpConnectionStatus(
            name=name,
            state="connected",
            transport=getattr(config, "type", "unknown"),
            auth_configured=auth_configured,
            tools=tools,
            resources=resources,
        )
