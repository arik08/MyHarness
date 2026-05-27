"""Tests for MCP tool adapters — input model generation and argument serialization."""

import asyncio

import pytest
from pydantic import ValidationError

from myharness.mcp.types import McpToolInfo
from myharness.tools.base import ToolExecutionContext
from myharness.tools.mcp_tool import McpToolAdapter, _input_model_from_schema


class TestInputModelFromSchema:
    """Verify _input_model_from_schema maps JSON Schema types correctly."""

    def test_required_string_rejects_none(self):
        schema = {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
        Model = _input_model_from_schema("search", schema)
        with pytest.raises(ValidationError):
            Model(query=None)

    def test_required_string_accepts_value(self):
        schema = {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        }
        Model = _input_model_from_schema("search", schema)
        m = Model(query="zigzag")
        assert m.query == "zigzag"

    def test_optional_string_defaults_to_none(self):
        schema = {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "wing": {"type": "string"},
            },
            "required": ["query"],
        }
        Model = _input_model_from_schema("search", schema)
        m = Model(query="test")
        assert m.wing is None

    def test_exclude_none_omits_optional_keeps_required(self):
        schema = {
            "type": "object",
            "properties": {
                "query": {"type": "string"},
                "wing": {"type": "string"},
                "limit": {"type": "integer"},
            },
            "required": ["query"],
        }
        Model = _input_model_from_schema("search", schema)
        m = Model(query="test")
        dumped = m.model_dump(mode="json", exclude_none=True)
        assert dumped == {"query": "test"}

    def test_all_json_types_mapped(self):
        schema = {
            "type": "object",
            "properties": {
                "name": {"type": "string"},
                "count": {"type": "integer"},
                "score": {"type": "number"},
                "active": {"type": "boolean"},
                "tags": {"type": "array"},
                "meta": {"type": "object"},
            },
            "required": ["name", "count", "score", "active", "tags", "meta"],
        }
        Model = _input_model_from_schema("full", schema)
        m = Model(name="x", count=1, score=0.5, active=True, tags=["a"], meta={"k": "v"})
        dumped = m.model_dump(mode="json")
        assert dumped == {
            "name": "x", "count": 1, "score": 0.5,
            "active": True, "tags": ["a"], "meta": {"k": "v"},
        }

    def test_empty_schema_creates_valid_model(self):
        Model = _input_model_from_schema("empty", {"type": "object"})
        m = Model()
        assert m.model_dump(mode="json") == {}

    def test_model_rejects_null_for_required_integer(self):
        schema = {
            "type": "object",
            "properties": {"limit": {"type": "integer"}},
            "required": ["limit"],
        }
        Model = _input_model_from_schema("limited", schema)
        with pytest.raises(ValidationError):
            Model(limit=None)


class FakeMcpManager:
    def __init__(self, output: str, *, delay: float = 0.0) -> None:
        self.output = output
        self.delay = delay
        self.calls = 0

    async def call_tool(self, server_name: str, tool_name: str, arguments: dict):
        if self.delay:
            await asyncio.sleep(self.delay)
        self.calls += 1
        return self.output


@pytest.mark.asyncio
async def test_mcp_tool_strips_noisy_not_found_warning_from_display():
    adapter = McpToolAdapter(
        FakeMcpManager(
            "[NOT_FOUND] '이사의 선관주의의무' 판례 검색 결과가 없습니다.\n\n"
            "⚠️ LLM은 판례를 추측/생성하지 마세요. 사용자에게 '검색 실패'를 보고하세요.\n\n"
            "힌트: 법제처 API는 공백 구분 키워드를 AND 조건으로 처리합니다.\n"
            "재시도 제안: \"이사의\" 또는 \"이사의 선관주의의무\"\n"
        ),
        McpToolInfo(
            server_name="korean-law",
            name="search_decisions",
            description="Search",
            input_schema={"type": "object", "properties": {}},
        ),
    )

    result = await adapter.execute(
        adapter.input_model.model_validate({}),
        ToolExecutionContext(cwd=".", metadata={"selected_mcp_server": "korean-law"}),
    )

    assert result.is_error is True
    assert "LLM은" not in result.output
    assert "힌트:" in result.output
    assert "재시도 제안" in result.output
    assert result.metadata["display_output"] == result.output


@pytest.mark.asyncio
async def test_selected_mcp_tool_call_count_does_not_block_calls():
    manager = FakeMcpManager("ok")
    adapter = McpToolAdapter(
        manager,
        McpToolInfo(
            server_name="korean-law",
            name="search_decisions",
            description="Search",
            input_schema={"type": "object", "properties": {}},
        ),
    )

    result = await adapter.execute(
        adapter.input_model.model_validate({}),
        ToolExecutionContext(
            cwd=".",
            metadata={"selected_mcp_server": "korean-law", "selected_mcp_tool_calls": 4},
        ),
    )

    assert result.is_error is False
    assert result.output == "ok"
    assert manager.calls == 1


@pytest.mark.asyncio
async def test_selected_mcp_tool_calls_continue_with_shared_metadata_count():
    manager = FakeMcpManager("ok")
    adapter = McpToolAdapter(
        manager,
        McpToolInfo(
            server_name="korean-law",
            name="search_decisions",
            description="Search",
            input_schema={"type": "object", "properties": {}},
        ),
    )
    shared = {"selected_mcp_server": "korean-law", "selected_mcp_tool_calls": 3}

    first = await adapter.execute(
        adapter.input_model.model_validate({}),
        ToolExecutionContext(
            cwd=".",
            metadata={"selected_mcp_server": "korean-law", "_shared_tool_metadata": shared},
        ),
    )
    second = await adapter.execute(
        adapter.input_model.model_validate({}),
        ToolExecutionContext(
            cwd=".",
            metadata={"selected_mcp_server": "korean-law", "_shared_tool_metadata": shared},
        ),
    )

    assert first.is_error is False
    assert second.is_error is False
    assert manager.calls == 2


@pytest.mark.asyncio
async def test_mcp_tool_times_out(monkeypatch):
    monkeypatch.setenv("MYHARNESS_MCP_TOOL_TIMEOUT_SECONDS", "0.01")
    adapter = McpToolAdapter(
        FakeMcpManager("late", delay=0.05),
        McpToolInfo(
            server_name="korean-law",
            name="search_decisions",
            description="Search",
            input_schema={"type": "object", "properties": {}},
        ),
    )

    result = await adapter.execute(
        adapter.input_model.model_validate({}),
        ToolExecutionContext(cwd="."),
    )

    assert result.is_error is True
    assert "timed out" in result.output
