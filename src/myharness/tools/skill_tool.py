"""Tool for reading skill contents."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

from myharness.skills import load_skill_registry
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
        increment_skill_usage_count(skill.name)
        return ToolResult(output=_format_skill_output(skill))


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
