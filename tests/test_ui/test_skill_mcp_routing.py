"""Tests for skill-mcp selection routing to an underlying MCP server."""

from __future__ import annotations

from myharness.skills.types import SkillDefinition
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost
from myharness.ui.protocol import SkillSnapshot


class StaticApiClient:
    async def stream_message(self, request):
        del request
        raise AssertionError("stream_message should not be called")


def test_skill_mcp_selection_maps_to_source_server_without_hiding_skill_content() -> None:
    host = ReactBackendHost(BackendHostConfig(api_client=StaticApiClient()))
    host._mcp_statuses_for_snapshot = lambda: []  # type: ignore[method-assign]
    host._skill_snapshots = lambda hide_learned=True: [  # type: ignore[method-assign]
        SkillSnapshot(
            name="vector-db-rag",
            description="Use local Vector GraphRAG MCP",
            source="skill-mcp:vector_db",
        )
    ]
    host._loaded_skill_by_name = lambda name: SkillDefinition(  # type: ignore[method-assign]
        name=name,
        description="Use local Vector GraphRAG MCP",
        content="Call store_status first, then retrieve_context or explore_org.",
        source="skill-mcp:vector_db",
    )

    selected = host._parse_forced_mcp_routed_skill_line("$mcp:vector-db-rag 마케팅본부 업무")
    prompt = host._line_with_forced_skill("$mcp:vector-db-rag 마케팅본부 업무")

    assert selected == ("vector_db", "마케팅본부 업무")
    assert "explicitly selected the `vector-db-rag` skill" in prompt
    assert "Call store_status first" in prompt
