from __future__ import annotations

from pydantic import BaseModel

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolRegistry, ToolResult


class _Input(BaseModel):
    value: str = ""


class _CountingTool(BaseTool):
    input_model = _Input

    def __init__(self, name: str, description: str) -> None:
        self.name = name
        self.description = description
        self.schema_calls = 0

    def to_api_schema(self):
        self.schema_calls += 1
        return super().to_api_schema()

    async def execute(self, arguments: _Input, context: ToolExecutionContext) -> ToolResult:
        del arguments, context
        return ToolResult(output="ok")


def test_tool_registry_caches_schemas_until_registration_changes() -> None:
    first_tool = _CountingTool("probe", "first")
    registry = ToolRegistry()
    registry.register(first_tool)

    first = registry.to_api_schema()
    first.clear()
    second = registry.to_api_schema()

    assert first_tool.schema_calls == 1
    assert [schema["name"] for schema in second] == ["probe"]

    replacement = _CountingTool("probe", "replacement")
    registry.register(replacement)

    refreshed = registry.to_api_schema()
    assert first_tool.schema_calls == 1
    assert replacement.schema_calls == 1
    assert refreshed[0]["description"] == "replacement"

    assert registry.unregister("probe") is replacement
    assert registry.to_api_schema() == []
