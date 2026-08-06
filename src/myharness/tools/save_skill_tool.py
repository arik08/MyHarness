"""Create or update a complete MyHarness skill in one validated operation."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, Field

from myharness.learning import get_default_learning_skills_dir
from myharness.skills import load_skill_registry
from myharness.skills.refresh import mark_skill_registry_dirty
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.path_display import display_tool_path
from myharness.utils.fs import atomic_write_text


class SaveSkillToolInput(BaseModel):
    """Complete content and UI metadata for one MyHarness skill."""

    name: str = Field(
        description="Lowercase hyphen-case skill name, using only letters, digits, and hyphens."
    )
    description: str = Field(
        description="Complete trigger description stating what the skill does and when to use it."
    )
    instructions: str = Field(
        description=(
            "Complete Markdown body after the YAML frontmatter. Include the heading and all final "
            "instructions; do not include TODO placeholders or another frontmatter block."
        )
    )
    display_name: str | None = Field(default=None, description="Optional human-facing skill name.")
    short_description: str | None = Field(
        default=None,
        description=(
            "Optional concise UI description. Values outside 25-64 characters are safely normalized "
            "instead of failing the save."
        ),
    )
    default_prompt: str | None = Field(
        default=None,
        description=(
            "Optional example prompt. The tool ensures it explicitly references the skill as $name."
        ),
    )
    mode: Literal["create", "update"] = Field(
        default="create",
        description="Use create for a new skill and update only for an existing skill.",
    )


class SaveSkillTool(BaseTool):
    """Persist a complete skill without shell scripts or template patching."""

    name = "save_skill"
    description = (
        "Create or update one complete MyHarness skill in a single validated operation. "
        "Use this instead of running skill-creator Python scripts and then reading or editing a template. "
        "New skills are saved under the program-local .skills/POSCO_Skill category, independent of "
        "the current chat workspace. The tool writes UTF-8 SKILL.md and agents/openai.yaml, normalizes "
        "UI metadata, validates the result, and triggers the live skill catalog refresh."
    )
    input_model = SaveSkillToolInput

    async def execute(
        self,
        arguments: SaveSkillToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        name = arguments.name.strip().lower()
        if not re.fullmatch(r"[a-z0-9]+(?:-[a-z0-9]+)*", name) or len(name) > 64:
            return ToolResult(
                output="Skill name must be 1-64 lowercase letters, digits, and hyphens.",
                is_error=True,
            )

        description = arguments.description.strip()
        instructions = arguments.instructions.strip()
        if not description:
            return ToolResult(output="Skill description is required.", is_error=True)
        if "<" in description or ">" in description:
            return ToolResult(
                output="Skill description cannot contain angle brackets (< or >).",
                is_error=True,
            )
        if len(description) > 1024:
            return ToolResult(
                output=(
                    f"Skill description is too long ({len(description)} characters). "
                    "Maximum is 1024 characters."
                ),
                is_error=True,
            )
        if not instructions:
            return ToolResult(output="Complete skill instructions are required.", is_error=True)
        if "[TODO" in description or "[TODO" in instructions:
            return ToolResult(output="Remove all TODO placeholders before saving the skill.", is_error=True)
        if instructions.startswith("---"):
            return ToolResult(
                output="Pass only the Markdown body in instructions; frontmatter is generated automatically.",
                is_error=True,
            )

        existing = load_skill_registry(
            context.cwd,
            extra_skill_dirs=context.metadata.get("extra_skill_dirs"),
            extra_plugin_roots=context.metadata.get("extra_plugin_roots"),
            include_disabled=True,
        ).get(name)
        if arguments.mode == "create":
            if existing is not None:
                return ToolResult(
                    output=f"Skill '{name}' already exists. Use mode='update' to replace it intentionally.",
                    is_error=True,
                )
            skill_dir = get_default_learning_skills_dir().resolve() / name
            action = "Created"
        else:
            if existing is None or not existing.path:
                return ToolResult(
                    output=f"Skill '{name}' was not found. Use mode='create' for a new skill.",
                    is_error=True,
                )
            skill_path = Path(existing.path).expanduser().resolve()
            if skill_path.name.casefold() != "skill.md":
                return ToolResult(output=f"Skill '{name}' has no writable SKILL.md path.", is_error=True)
            skill_dir = skill_path.parent
            action = "Updated"

        display_name = (arguments.display_name or "").strip() or _display_name(name)
        short_description = _normalized_short_description(
            arguments.short_description,
            description=description,
            display_name=display_name,
        )
        default_prompt = _normalized_default_prompt(arguments.default_prompt, name=name)
        skill_content = _skill_markdown(name, description, instructions)
        openai_content = yaml.safe_dump(
            {
                "interface": {
                    "display_name": display_name,
                    "short_description": short_description,
                    "default_prompt": default_prompt,
                }
            },
            allow_unicode=True,
            sort_keys=False,
        )

        skill_path = skill_dir / "SKILL.md"
        openai_path = skill_dir / "agents" / "openai.yaml"
        atomic_write_text(skill_path, skill_content)
        atomic_write_text(openai_path, openai_content)
        mark_skill_registry_dirty(context.metadata, skill_path)

        return ToolResult(
            output=(
                f"{action} and validated skill '{name}' at "
                f"{display_tool_path(skill_path, context.cwd)}. "
                "The live skill catalog refresh was requested; no Python command or template edit is needed."
            ),
            metadata={
                "skill_name": name,
                "skill_path": str(skill_path),
                "short_description": short_description,
                "default_prompt": default_prompt,
            },
        )


def _display_name(name: str) -> str:
    return " ".join(part.capitalize() for part in name.split("-"))


def _normalized_short_description(
    candidate: str | None,
    *,
    description: str,
    display_name: str,
) -> str:
    value = (candidate or "").strip()
    if not 25 <= len(value) <= 64:
        value = description.strip()
    if len(value) > 64:
        value = value[:64].rstrip()
    if len(value) < 25:
        value = f"{display_name} 관련 요청을 정확하고 일관되게 처리하도록 지원합니다."
    if len(value) > 64:
        value = value[:64].rstrip()
    return value


def _normalized_default_prompt(candidate: str | None, *, name: str) -> str:
    value = (candidate or "").strip()
    reference = f"${name}"
    if not value:
        return f"{reference} 스킬을 사용하여 요청을 처리해 주세요."
    if reference not in value:
        return f"{reference} 스킬을 사용하여 {value}"
    return value


def _skill_markdown(name: str, description: str, instructions: str) -> str:
    frontmatter = yaml.safe_dump(
        {"name": name, "description": description},
        allow_unicode=True,
        sort_keys=False,
    ).strip()
    return f"---\n{frontmatter}\n---\n\n{instructions}\n"
