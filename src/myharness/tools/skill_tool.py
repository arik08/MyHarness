"""Tool for reading skill contents."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from myharness.skills import load_skill_registry
from myharness.mcp.types import is_dummy_mcp
from myharness.skills.state import increment_skill_usage_count
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class SkillToolInput(BaseModel):
    """Arguments for skill lookup."""

    name: str = Field(description="Skill name")
    mode: Literal["use", "source"] = Field(
        default="use",
        description=(
            "Use 'use' to load skill instructions for your own work. "
            "Use 'source' when the user asks to view the skill source, full contents, raw SKILL.md, or how the skill is written; "
            "the full source will be shown directly to the user without being returned to the model context."
        ),
    )


class SkillTool(BaseTool):
    """Return the content of a loaded skill."""

    name = "skill"
    description = (
        "Read a bundled, user, or plugin skill by name. "
        "Also activate an available MCP integration by its listed skill name when its data is useful for the task, "
        "without waiting for the user to name it; this loads instructions and connects its tools on demand. "
        "Disabled skills may be loaded when the user explicitly requests them; "
        "do not select them automatically based on task triggers. "
        "If the user asks what a skill's source/full text/SKILL.md looks like, call this with mode='source'."
    )
    input_model = SkillToolInput

    def is_read_only(self, arguments: SkillToolInput) -> bool:
        del arguments
        return True

    async def execute(self, arguments: SkillToolInput, context: ToolExecutionContext) -> ToolResult:
        registry = load_skill_registry(
            context.cwd,
            extra_skill_dirs=context.metadata.get("extra_skill_dirs"),
            extra_plugin_roots=context.metadata.get("extra_plugin_roots"),
            include_disabled=True,
        )
        skill = registry.get(arguments.name) or registry.get(arguments.name.lower()) or registry.get(arguments.name.title())
        if skill is None:
            return ToolResult(output=f"스킬을 찾을 수 없습니다: {arguments.name}", is_error=True)
        if arguments.mode == "source":
            transcript_output = _format_skill_source_output(skill)
            model_output = (
                f"Displayed the full source for skill '{skill.name}' directly to the user. "
                "Do not repeat the source text; briefly mention that it is shown above if needed."
            )
            return ToolResult(
                output=model_output,
                metadata={
                    "model_output": model_output,
                    "transcript_output": transcript_output,
                },
            )
        activation_error = await _activate_routed_mcp(skill, context)
        increment_skill_usage_count(skill.name)
        output = _format_skill_output(skill)
        if activation_error:
            output += f"\n\nMCP 활성화 실패: {activation_error}\n스킬 지침만 로드되었으며 MCP 데이터는 조회되지 않았습니다."
        else:
            from myharness.skills.routing import mcp_server_name_from_skill_source

            server_name = mcp_server_name_from_skill_source(skill.source)
            tool_registry = context.metadata.get("tool_registry")
            if server_name and tool_registry is not None:
                names = [
                    tool.name for tool in tool_registry.list_tools()
                    if getattr(getattr(tool, "_tool_info", None), "server_name", None) == server_name
                ]
                output += (
                    f"\n\n활성 MCP 서버: {server_name}\n호출 가능한 도구: {', '.join(names)}\n"
                    "각 source는 이 스킬에 명시된 서버에서만 조회하세요. 다른 스킬의 source를 "
                    "이름이 같은 도구에 전달하지 마세요. 여러 스킬을 사용하면 서버별 호출 경로를 "
                    "유지하고, 도구의 원본 스키마에 있는 기본값·허용값·타입을 따르세요. "
                    "공식 ID는 카탈로그나 검색 결과에서 확인하고 추측하지 마세요."
                )
        return ToolResult(output=output, is_error=bool(activation_error))


async def _activate_routed_mcp(skill, context: ToolExecutionContext) -> str | None:
    """Connect and register a skill-backed MCP server on first use."""
    from myharness.skills.routing import is_mcp_routed_skill, mcp_server_name_from_skill_source
    from myharness.tools.mcp_tool import McpToolAdapter

    if not is_mcp_routed_skill(skill):
        return
    if is_dummy_mcp(mcp_server_name_from_skill_source(skill.source)):
        return "더미 MCP이므로 실행이 차단되어 있습니다. 연결을 시도하지 않습니다."
    manager = context.metadata.get("mcp_manager")
    tool_registry = context.metadata.get("tool_registry")
    if manager is None or tool_registry is None:
        return "현재 실행 환경에 MCP 연결 관리자 또는 도구 레지스트리가 없습니다."
    server_name = mcp_server_name_from_skill_source(skill.source)
    if not server_name:
        return "스킬의 MCP 서버 식별자가 없습니다."
    config = manager.get_server_config(server_name)
    if config is None:
        return f"{server_name} 서버가 설정되지 않았거나 비활성화되어 있습니다."
    try:
        await manager.ensure_server_config(server_name, config, force_connect=True)
    except Exception:
        # Connection exceptions may contain credential-bearing URLs or arguments.
        return f"{server_name} 서버 연결에 실패했습니다. MCP 연결 상태를 확인하세요."
    status = next(
        (item for item in manager.list_statuses() if item.name == server_name),
        None,
    )
    if status is None or status.state != "connected":
        return f"{server_name} 서버가 연결되지 않았습니다. MCP 연결 상태를 확인하세요."
    if not status.tools:
        return f"{server_name} 서버는 연결되었지만 사용 가능한 도구가 없습니다."
    for tool_info in status.tools:
        tool_registry.register(McpToolAdapter(manager, tool_info))


def _format_skill_output(skill) -> str:
    """Return skill content with user-facing metadata first."""
    description = str(getattr(skill, "description", "") or "").strip()
    if not description:
        description = f"스킬: {skill.name}"
    return (
        f"스킬: {skill.name}\n"
        f"설명: {description}\n\n"
        f"{skill.content}"
    )


def _markdown_fence_for_content(content: str, info: str = "md") -> str:
    fence = "~~~"
    while fence in content:
        fence += "~"
    return f"{fence}{info}\n{content.rstrip()}\n{fence}"


def _format_skill_source_output(skill) -> str:
    """Return raw skill source for direct user display."""
    description = str(getattr(skill, "description", "") or "").strip()
    lines = [
        "LLM 컨텍스트에 원문을 넣지 않고 스킬 원문을 직접 표시합니다.",
        "",
        f"- 스킬: `{skill.name}`",
        f"- 설명: {description or '설명 없음'}",
        f"- 출처: `{getattr(skill, 'source', '') or 'unknown'}`",
    ]
    path = str(getattr(skill, "path", "") or "").strip()
    if path:
        lines.append(f"- 파일: `{path}`")
    lines.extend(["", _markdown_fence_for_content(str(getattr(skill, "content", "") or ""))])
    return "\n".join(lines)
