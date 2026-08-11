"""Minimal placeholder MCP server for planned POSCO connectors."""

from __future__ import annotations

import sys

from mcp.server.fastmcp import FastMCP
from myharness.mcp.skill_resources import attach_packaged_skill


server = FastMCP(sys.argv[1] if len(sys.argv) > 1 else "posco-connector")
attach_packaged_skill(server, __file__)


if __name__ == "__main__":
    server.run("stdio")
