"""Create or update a complete MyHarness skill in one validated operation."""

from __future__ import annotations

import re
from pathlib import Path, PurePosixPath
from typing import Literal

import yaml
from pydantic import BaseModel, Field

from myharness.learning import get_default_learning_skills_dir
from myharness.skills import load_skill_registry
from myharness.skills.refresh import mark_skill_registry_dirty
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.path_display import display_tool_path
from myharness.utils.fs import atomic_write_text


class SkillSupportingFile(BaseModel):
    """One text resource bundled with a skill."""

    path: str = Field(
        description=(
            "Relative path under scripts/, references/, or assets/, for example "
            "scripts/generate_number.py."
        )
    )
    content: str = Field(description="Complete UTF-8 text content for the supporting file.")


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
    supporting_files: list[SkillSupportingFile] = Field(
        default_factory=list,
        description=(
            "Optional reusable text files to save with the skill under scripts/, references/, or assets/. "
            "Put executable Python in scripts/*.py instead of only embedding it in SKILL.md."
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
        "You must first load skill-creator with the skill tool in the current conversation session; "
        "this tool rejects direct calls that skip those instructions. "
        "Use this instead of running skill-creator Python scripts and then reading or editing a template. "
        "New skills are saved under the program-local .skills/POSCO_Skill category, independent of "
        "the current chat workspace. The tool writes UTF-8 SKILL.md, agents/openai.yaml, and optional "
        "supporting_files under scripts/, references/, or assets/. Put reusable executable Python in a "
        "scripts/*.py supporting file so its creation is visible in the workflow. The tool normalizes UI "
        "metadata, validates the result, and triggers the live skill catalog refresh."
    )
    input_model = SaveSkillToolInput

    async def execute(
        self,
        arguments: SaveSkillToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        invoked_skills = context.metadata.get("invoked_skills")
        loaded_skill_names = {
            str(skill_name).strip().casefold()
            for skill_name in invoked_skills
        } if isinstance(invoked_skills, list) else set()
        if "skill-creator" not in loaded_skill_names:
            return ToolResult(
                output=(
                    "Load skill-creator first with skill(name='skill-creator', mode='use') in the "
                    "current conversation session, then retry save_skill with the completed instructions."
                ),
                is_error=True,
            )

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
        try:
            supporting_targets = _supporting_file_targets(skill_dir, arguments.supporting_files)
        except ValueError as exc:
            return ToolResult(output=str(exc), is_error=True)
        atomic_write_text(skill_path, skill_content)
        atomic_write_text(openai_path, openai_content)
        for supporting_file, target in supporting_targets:
            atomic_write_text(target, supporting_file.content)
        mark_skill_registry_dirty(context.metadata, skill_path)

        written_paths = [skill_path, openai_path, *(target for _file, target in supporting_targets)]
        supporting_summary = (
            f" Wrote {len(supporting_targets)} supporting file(s): "
            + ", ".join(display_tool_path(target, context.cwd) for _file, target in supporting_targets)
            + "."
            if supporting_targets
            else ""
        )

        return ToolResult(
            output=(
                f"{action} and validated skill '{name}' at "
                f"{display_tool_path(skill_path, context.cwd)}. "
                f"{supporting_summary} "
                "The live skill catalog refresh was requested; no Python initialization command or "
                "template edit is needed."
            ),
            metadata={
                "skill_name": name,
                "skill_path": str(skill_path),
                "short_description": short_description,
                "default_prompt": default_prompt,
                "written_files": [str(path) for path in written_paths],
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


def _supporting_file_targets(
    skill_dir: Path,
    files: list[SkillSupportingFile],
) -> list[tuple[SkillSupportingFile, Path]]:
    if len(files) > 50:
        raise ValueError("A skill can include at most 50 supporting files.")

    skill_root = skill_dir.resolve()
    targets: list[tuple[SkillSupportingFile, Path]] = []
    seen: set[str] = set()
    for supporting_file in files:
        raw_path = supporting_file.path.strip().replace("\\", "/")
        relative_path = PurePosixPath(raw_path)
        if (
            not raw_path
            or relative_path.is_absolute()
            or any(part in {"", ".", ".."} for part in relative_path.parts)
            or relative_path.parts[0].casefold() not in {"scripts", "references", "assets"}
        ):
            raise ValueError(
                "Supporting file paths must be relative paths under scripts/, references/, or assets/."
            )
        key = relative_path.as_posix().casefold()
        if key in seen:
            raise ValueError(f"Duplicate supporting file path: {relative_path.as_posix()}")
        seen.add(key)
        target = (skill_root / Path(*relative_path.parts)).resolve()
        try:
            target.relative_to(skill_root)
        except ValueError as exc:
            raise ValueError("Supporting file path must stay inside the skill directory.") from exc
        targets.append((supporting_file, target))
    return targets
