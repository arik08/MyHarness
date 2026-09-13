"""MCP configuration and state models."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, Field, PrivateAttr


DUMMY_MCP_SERVERS = frozenset({
    "posco-calender", "posco-datalake", "posco-ecm", "posco-email", "posco-erp",
    "posco-gih", "posco-mih", "posco-ontology", "posco-plm",
})


def is_dummy_mcp(name: str) -> bool:
    return name.strip().lower() in DUMMY_MCP_SERVERS


class McpStdioServerConfig(BaseModel):
    """stdio MCP server configuration."""

    _cwd_base: str | None = PrivateAttr(default=None)

    type: Literal["stdio"] = "stdio"
    command: str
    args: list[str] = Field(default_factory=list)
    env: dict[str, str] | None = None
    cwd: str | None = None
    auto_connect: bool = True
    description: str = ""
    read_only_tools: list[str] = Field(default_factory=list)


class McpHttpServerConfig(BaseModel):
    """HTTP MCP server configuration."""

    type: Literal["http"] = "http"
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    auto_connect: bool = True
    description: str = ""
    read_only_tools: list[str] = Field(default_factory=list)


class McpWebSocketServerConfig(BaseModel):
    """WebSocket MCP server configuration."""

    type: Literal["ws"] = "ws"
    url: str
    headers: dict[str, str] = Field(default_factory=dict)
    auto_connect: bool = True
    description: str = ""
    read_only_tools: list[str] = Field(default_factory=list)


McpServerConfig = McpStdioServerConfig | McpHttpServerConfig | McpWebSocketServerConfig


class McpAuthConfig(BaseModel):
    """Credential overlay kept separate from an MCP package runtime definition."""

    env: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)


class McpJsonConfig(BaseModel):
    """Config file shape used by plugins and project files."""

    mcpServers: dict[str, McpServerConfig] = Field(default_factory=dict)


@dataclass(frozen=True)
class McpToolInfo:
    """Tool metadata exposed by an MCP server."""

    server_name: str
    name: str
    description: str
    input_schema: dict[str, object]
    read_only: bool = False


@dataclass(frozen=True)
class McpResourceInfo:
    """Resource metadata exposed by an MCP server."""

    server_name: str
    name: str
    uri: str
    description: str = ""


@dataclass
class McpConnectionStatus:
    """Runtime status for one MCP server."""

    name: str
    state: Literal["connected", "failed", "pending", "disabled"]
    detail: str = ""
    description: str = ""
    transport: str = "unknown"
    auth_configured: bool = False
    instructions: str = ""
    tools: list[McpToolInfo] = field(default_factory=list)
    resources: list[McpResourceInfo] = field(default_factory=list)
