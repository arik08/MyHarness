"""MCP tool adapters."""

from __future__ import annotations

import asyncio
import os
import re

from pydantic import BaseModel, Field, create_model

from myharness.mcp.client import McpClientManager, McpServerNotConnectedError
from myharness.mcp.types import McpToolInfo
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class McpToolAdapter(BaseTool):
    """Expose one MCP tool as a normal MyHarness tool."""

    def __init__(self, manager: McpClientManager, tool_info: McpToolInfo) -> None:
        self._manager = manager
        self._tool_info = tool_info
        server_segment = _sanitize_tool_segment(tool_info.server_name)
        tool_segment = _sanitize_tool_segment(tool_info.name)
        self.name = f"mcp__{server_segment}__{tool_segment}"
        self.description = tool_info.description or f"MCP tool {tool_info.name}"
        self.input_model = _input_model_from_schema(self.name, tool_info.input_schema)

    async def execute(self, arguments: BaseModel, context: ToolExecutionContext) -> ToolResult:
        metadata = context.metadata
        shared_metadata = metadata.get("_shared_tool_metadata")
        if not isinstance(shared_metadata, dict):
            shared_metadata = metadata
        selected_server = str(metadata.get("selected_mcp_server") or "")
        if selected_server == self._tool_info.server_name:
            tool_calls = int(shared_metadata.get("selected_mcp_tool_calls") or 0)
            if tool_calls >= 4:
                message = (
                    "MCP tool-call limit reached for this selected server turn. "
                    "Stop calling more MCP tools and summarize the useful results already returned."
                )
                return ToolResult(
                    output=message,
                    is_error=True,
                    metadata={"display_output": "MCP 조회 제한에 도달했습니다. 이미 나온 결과를 요약하세요."},
                )
            shared_metadata["selected_mcp_tool_calls"] = tool_calls + 1
        try:
            output = await asyncio.wait_for(
                self._manager.call_tool(
                    self._tool_info.server_name,
                    self._tool_info.name,
                    arguments.model_dump(mode="json", exclude_none=True),
                ),
                timeout=_mcp_tool_timeout_seconds(),
            )
        except TimeoutError:
            return ToolResult(
                output=(
                    f"MCP tool timed out after {_mcp_tool_timeout_seconds():.0f} seconds: "
                    f"{self._tool_info.server_name}.{self._tool_info.name}"
                ),
                is_error=True,
            )
        except McpServerNotConnectedError as exc:
            return ToolResult(output=str(exc), is_error=True)
        if output.startswith("[NOT_FOUND]"):
            display_output = _strip_not_found_warning(output)
            model_output = display_output
            not_found_count = int(shared_metadata.get("selected_mcp_not_found_count") or 0) + 1
            shared_metadata["selected_mcp_not_found_count"] = not_found_count
            success_count = int(shared_metadata.get("selected_mcp_success_count") or 0)
            if selected_server == self._tool_info.server_name and (success_count > 0 or not_found_count > 1):
                model_output = (
                    f"{display_output}\n"
                    "Do not retry with more keyword variations in this turn. "
                    "Summarize the useful MCP results already available and mention this miss briefly."
                )
            return ToolResult(
                output=model_output,
                is_error=True,
                metadata={"display_output": display_output},
            )
        if selected_server == self._tool_info.server_name:
            shared_metadata["selected_mcp_success_count"] = int(shared_metadata.get("selected_mcp_success_count") or 0) + 1
        return ToolResult(output=output)


_JSON_TYPE_MAP: dict[str, type] = {
    "string": str,
    "integer": int,
    "number": float,
    "boolean": bool,
    "array": list,
    "object": dict,
}


def _input_model_from_schema(tool_name: str, schema: dict[str, object]) -> type[BaseModel]:
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        return create_model(f"{tool_name.title()}Input")

    fields = {}
    required = set(schema.get("required", [])) if isinstance(schema.get("required", []), list) else set()
    for key in properties:
        prop = properties[key] if isinstance(properties[key], dict) else {}
        py_type = _JSON_TYPE_MAP.get(str(prop.get("type", "")), object)
        if key in required:
            fields[key] = (py_type, Field(default=...))
        else:
            fields[key] = (py_type | None, Field(default=None))
    return create_model(f"{tool_name.title().replace('-', '_')}Input", **fields)


def _sanitize_tool_segment(value: str) -> str:
    sanitized = re.sub(r"[^A-Za-z0-9_-]", "_", value)
    if not sanitized:
        return "tool"
    if not sanitized[0].isalpha():
        return f"mcp_{sanitized}"
    return sanitized


def _strip_not_found_warning(output: str) -> str:
    """Remove noisy provider guidance while preserving the actual miss details."""
    lines = []
    for line in output.splitlines():
        if "LLM은" in line or "추측/생성" in line:
            continue
        lines.append(line)
    return "\n".join(lines).strip() or "[NOT_FOUND] MCP search returned no results."


def _mcp_tool_timeout_seconds() -> float:
    raw = os.environ.get("MYHARNESS_MCP_TOOL_TIMEOUT_SECONDS", "").strip()
    if raw:
        try:
            return max(0.001, float(raw))
        except ValueError:
            pass
    return 120.0
