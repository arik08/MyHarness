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
async def test_mcp_application_failure_is_not_counted_as_success(tmp_path):
    adapter = McpToolAdapter(FakeMcpManager('{"ok": false, "message": "not indexed"}'), McpToolInfo("rag", "status", "Status", {}))
    metadata = {"selected_mcp_server": "rag"}
    result = await adapter.execute(adapter.input_model(), ToolExecutionContext(cwd=tmp_path, metadata=metadata))
    assert result.is_error
    assert "not indexed" in result.output
    assert not metadata.get("selected_mcp_success_count")


def test_adapter_preserves_original_schema_and_isolates_caller_mutation():
    schema = {
        "type": "object",
        "properties": {
            "reporters": {"type": "array", "items": {"type": "string"}, "description": "Reporter codes"},
            "sort": {"type": "string", "enum": ["ldes", "lasc"], "default": "ldes"},
        },
        "required": ["reporters"],
    }
    adapter = McpToolAdapter(FakeMcpManager("ok"), McpToolInfo("test", "query", "Query", schema))
    exported = adapter.to_api_schema()
    assert exported["input_schema"] == schema
    exported["input_schema"]["properties"]["sort"]["enum"].append("broken")
    assert adapter.to_api_schema()["input_schema"] == schema


@pytest.mark.parametrize("read_only", [True, False])
def test_read_only_mcp_does_not_acquire_project_lock(read_only):
    adapter = McpToolAdapter(FakeMcpManager("ok"), McpToolInfo("test", "query", "Query", {}, read_only=read_only))
    args = adapter.input_model()
    assert adapter.is_read_only(args) is read_only
    assert adapter.requires_project_mutation_lock(args) is not read_only


@pytest.mark.asyncio
async def test_adapter_omits_optional_null_but_preserves_required_null(tmp_path):
    from unittest.mock import AsyncMock
    manager = FakeMcpManager("ok")
    manager.call_tool = AsyncMock(return_value="ok")
    schema = {"type": "object", "properties": {
        "nullable": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        "sort": {"type": "string", "default": "ldes"},
    }, "required": ["nullable"]}
    adapter = McpToolAdapter(manager, McpToolInfo("test", "query", "Query", schema))
    await adapter.execute(adapter.input_model(nullable=None, sort=None), ToolExecutionContext(cwd=tmp_path))
    manager.call_tool.assert_awaited_once_with("test", "query", {"nullable": None})


@pytest.mark.asyncio
async def test_parallel_mcp_reads_finish_while_another_session_holds_lock(tmp_path):
    from myharness.config.settings import PermissionSettings
    from myharness.permissions import PermissionChecker, PermissionMode
    from myharness.permissions.mutation_lock import acquire_mutation_lock, release_mutation_lock
    from myharness.engine.query import QueryContext, _execute_tool_call
    from myharness.tools.base import ToolRegistry

    registry = ToolRegistry()
    for server in ("first", "second"):
        registry.register(McpToolAdapter(FakeMcpManager("ok"), McpToolInfo(server, "query", "Read", {}, read_only=True)))
    context = QueryContext(
        api_client=None, tool_registry=registry,
        permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        cwd=tmp_path, model="test", system_prompt="", max_tokens=100, tool_metadata={},
    )
    token = await acquire_mutation_lock(tmp_path, owner="other-session")
    try:
        results = await asyncio.wait_for(asyncio.gather(*(
            _execute_tool_call(context, f"mcp__{server}__query", server, {})
            for server in ("first", "second")
        )), timeout=1)
        assert all(not result.is_error for result in results)
        assert token.path.exists()
        assert "mutation_lock_token" not in context.tool_metadata
    finally:
        release_mutation_lock(token)


@pytest.mark.asyncio
async def test_tool_search_finds_multiple_mcp_routes_from_multiword_query(tmp_path):
    from myharness.tools.base import ToolRegistry
    from myharness.tools.tool_search_tool import ToolSearchTool, ToolSearchToolInput
    registry = ToolRegistry()
    for server in ("company-disclosure", "trade-market"):
        registry.register(McpToolAdapter(FakeMcpManager("ok"), McpToolInfo(server, "get_source_health", "Health", {})))
    result = await ToolSearchTool().execute(
        ToolSearchToolInput(query="trade-market get_source_health customs_kr"),
        ToolExecutionContext(cwd=tmp_path, metadata={"tool_registry": registry}),
    )
    assert result.output.splitlines()[0].startswith("mcp__trade-market__get_source_health")


@pytest.mark.asyncio
async def test_skill_activation_uses_active_registry_not_stale_shared_metadata(tmp_path):
    from myharness.config.settings import PermissionSettings
    from myharness.permissions import PermissionChecker, PermissionMode
    from myharness.engine.query import QueryContext, _execute_tool_call, _select_tool_schemas
    from myharness.tools.base import BaseTool, ToolRegistry, ToolResult
    from pydantic import BaseModel

    class ActivateInput(BaseModel):
        pass

    class ActivateTool(BaseTool):
        name = "activate"
        description = "Activate another MCP"
        input_model = ActivateInput
        def is_read_only(self, arguments): return True
        async def execute(self, arguments, context):
            context.metadata["tool_registry"].register(McpToolAdapter(
                FakeMcpManager("ok"), McpToolInfo("second", "query", "Read", {}, read_only=True),
            ))
            return ToolResult(output="activated")

    active, stale = ToolRegistry(), ToolRegistry()
    active.register(ActivateTool())
    context = QueryContext(
        api_client=None, tool_registry=active,
        permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        cwd=tmp_path, model="test", system_prompt="", max_tokens=100,
        tool_metadata={"tool_registry": stale},
    )
    result = await _execute_tool_call(context, "activate", "activation", {})
    assert not result.is_error
    names = {s["name"] for s in _select_tool_schemas(context, [], was_compacted=False)}
    assert "mcp__second__query" in names
    assert stale.get("mcp__second__query") is None


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
