"""End-to-end stdio startup checks for grouped official-data MCP servers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from myharness.mcp.client import McpClientManager, McpToolExecutionError
from myharness.mcp.config import load_mcp_configs_from_dirs


SERVER_NAMES = {
    "company-disclosure",
    "trade-market",
    "macro-finance",
    "legislation-regulation",
    "patent-tech",
    "environment-industry",
    "development-finance",
}

STATIC_TOOL_CALLS = {
    "company-disclosure": (
        "get_document_link",
        {"source": "opendart", "record_id": "20250101000001"},
    ),
    "trade-market": ("search_catalog", {"source": "customs_kr", "limit": 1}),
    "macro-finance": ("search_catalog", {"source": "ecb", "limit": 1}),
    "legislation-regulation": (
        "search_catalog",
        {"source": "federal_register", "limit": 1},
    ),
    "patent-tech": ("search_catalog", {"source": "crossref", "limit": 1}),
    "environment-industry": (
        "search_catalog",
        {"source": "eurostat_prodcom", "limit": 1},
    ),
}


@pytest.mark.asyncio
async def test_grouped_official_data_servers_start_and_list_tools() -> None:
    root = Path(__file__).resolve().parents[2]
    all_configs = load_mcp_configs_from_dirs([root / ".skills" / "mcp"])
    configs = {name: all_configs[name] for name in SERVER_NAMES}
    manager = McpClientManager(configs)

    try:
        for name, config in configs.items():
            await manager.ensure_server_config(name, config, force_connect=True)
        statuses = {status.name: status for status in manager.list_statuses()}

        assert set(statuses) == SERVER_NAMES
        assert all(status.state == "connected" for status in statuses.values())
        assert all(status.tools for status in statuses.values())
        assert all(status.resources for status in statuses.values())

        for server_name, (tool_name, arguments) in STATIC_TOOL_CALLS.items():
            output = json.loads(await manager.call_tool(server_name, tool_name, arguments))
            assert output["source"]
            assert output["source_id"]
            assert output["retrieved_at"]

        for status in statuses.values():
            assert any(resource.uri.startswith("skill://") for resource in status.resources)
            overview = next(resource for resource in status.resources if not resource.uri.startswith("skill://"))
            resource = json.loads(
                await manager.read_resource(status.name, overview.uri)
            )
            assert resource

        with pytest.raises(McpToolExecutionError, match="start_period and end_period"):
            await manager.call_tool(
                "development-finance",
                "query_series",
                {
                    "source": "adb",
                    "dataflow": "EO_NA",
                    "indicators": "NGDP_XDC",
                    "economies": "PHI",
                },
            )
    finally:
        await manager.close()
