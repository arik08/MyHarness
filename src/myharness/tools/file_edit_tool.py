"""String-based file editing tool."""

from __future__ import annotations

import asyncio
import re
from pathlib import Path

from pydantic import BaseModel, Field, model_validator

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.mermaid_preflight import (
    format_mermaid_preflight_errors,
    mermaid_preflight_errors,
)
from myharness.tools.html_source_footnotes import prepare_source_footnotes_html
from myharness.tools.path_display import display_tool_path
from myharness.skills.refresh import mark_skill_registry_dirty
from myharness.utils.fs import atomic_write_text


class FileReplacement(BaseModel):
    """One string replacement inside a file edit."""

    old_str: str = Field(description="Existing text to replace")
    new_str: str = Field(description="Replacement text")
    replace_all: bool = Field(default=False)


class FileEditToolInput(BaseModel):
    """Arguments for the file edit tool."""

    path: str = Field(description="Path of the file to edit")
    old_str: str | None = Field(default=None, description="Existing text to replace")
    new_str: str | None = Field(default=None, description="Replacement text")
    replace_all: bool = Field(default=False)
    edits: list[FileReplacement] | None = Field(
        default=None,
        description=(
            "Multiple replacements to apply in one call. Use this for related edits in the same file "
            "instead of calling edit_file repeatedly."
        ),
    )

    @model_validator(mode="after")
    def _validate_edit_shape(self) -> "FileEditToolInput":
        has_single = self.old_str is not None or self.new_str is not None
        has_edits = bool(self.edits)
        if has_single and has_edits:
            raise ValueError("Provide either old_str/new_str or edits, not both")
        if has_single and (self.old_str is None or self.new_str is None):
            raise ValueError("old_str and new_str must be provided together")
        if not has_single and not has_edits:
            raise ValueError("Provide old_str/new_str or at least one edit")
        return self


class FileEditTool(BaseTool):
    """Replace text in an existing file."""

    name = "edit_file"
    description = (
        "Edit an existing file by replacing text. For several related changes in the same file, "
        "provide an edits array and apply them in one tool call."
    )
    input_model = FileEditToolInput

    async def execute(
        self,
        arguments: FileEditToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        path = _resolve_path(context.cwd, arguments.path)

        from myharness.sandbox.session import is_docker_sandbox_active

        if is_docker_sandbox_active():
            from myharness.sandbox.path_validator import validate_sandbox_path

            allowed, reason = validate_sandbox_path(path, context.cwd)
            if not allowed:
                return ToolResult(output=f"Sandbox: {reason}", is_error=True)

        if not path.exists():
            return ToolResult(output=f"파일을 찾을 수 없습니다: {display_tool_path(path, context.cwd)}", is_error=True)
        version_guard = _active_artifact_version_guard(path, context)
        if version_guard:
            return ToolResult(output=version_guard, is_error=True)

        original = (await asyncio.to_thread(path.read_bytes)).decode("utf-8")
        replacements = arguments.edits
        if replacements is None:
            replacements = [
                FileReplacement(
                    old_str=arguments.old_str or "",
                    new_str=arguments.new_str or "",
                    replace_all=arguments.replace_all,
                )
            ]

        updated = original
        applied_count = 0
        for index, edit in enumerate(replacements, start=1):
            updated, count = _replace_preserving_newlines(updated, edit)
            if not count:
                return ToolResult(
                    output=f"{index}번째 편집의 old_str을 파일에서 찾을 수 없습니다.",
                    is_error=True,
                )
            applied_count += count

        updated = prepare_source_footnotes_html(updated, path.suffix, context.metadata)
        mermaid_errors = mermaid_preflight_errors(path, updated)
        if mermaid_errors:
            return ToolResult(
                output=format_mermaid_preflight_errors(path, mermaid_errors, action="updated"),
                is_error=True,
            )

        await asyncio.to_thread(
            atomic_write_text, path, updated, encoding="utf-8",
            create_directories=False,
        )
        mark_skill_registry_dirty(context.metadata, path)
        return ToolResult(
            output=f"{display_tool_path(path, context.cwd)}을(를) 업데이트했습니다. 치환 {applied_count}건"
        )


def _replace_preserving_newlines(text: str, edit: FileReplacement) -> tuple[str, int]:
    if not any(char in edit.old_str + edit.new_str for char in "\r\n"):
        count = text.count(edit.old_str)
        if not edit.replace_all:
            count = min(count, 1)
        return text.replace(edit.old_str, edit.new_str, -1 if edit.replace_all else 1), count

    # Match read_file's normalized lines without rewriting untouched bytes.
    # Do not allow one CRLF to backtrack into two separate line endings.
    boundary = r"(?:\r\n|\r(?!\n)|(?<!\r)\n)"
    pattern = boundary.join(re.escape(part) for part in re.split(r"\r\n|\r|\n", edit.old_str))
    replacement_parts = re.split(r"\r\n|\r|\n", edit.new_str)
    first_ending = re.search(r"\r\n|\r|\n", text)
    default_ending = first_ending.group() if first_ending else "\n"

    def replacement(match: re.Match[str]) -> str:
        endings = re.findall(r"\r\n|\r|\n", match.group()) or [default_ending]
        parts = [replacement_parts[0]]
        for index, part in enumerate(replacement_parts[1:]):
            parts.extend((endings[min(index, len(endings) - 1)], part))
        return "".join(parts)

    return re.subn(pattern, replacement, text, count=0 if edit.replace_all else 1)


def _resolve_path(base: Path, candidate: str) -> Path:
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _active_artifact_version_guard(path: Path, context: ToolExecutionContext) -> str:
    if not bool(context.metadata.get("compose_artifact_versioning")):
        return ""
    active = str(context.metadata.get("compose_active_artifact_path") or "").strip()
    if not active:
        return ""
    active_path = _resolve_path(context.cwd, active)
    if path != active_path:
        return ""
    next_path = _next_version_path(active_path)
    return (
        "활성 preview 산출물은 원본으로 보존해야 합니다. "
        f"`{display_tool_path(path, context.cwd)}`을(를) 직접 수정하지 말고, "
        f"`{display_tool_path(next_path, context.cwd)}` 같은 다음 버전 파일을 만든 뒤 그 파일을 수정하세요."
    )


def _next_version_path(path: Path) -> Path:
    stem = re.sub(r"[\s_]+(?:ver\.|v)\d+$", "", path.stem, flags=re.IGNORECASE)
    for index in range(1, 1000):
        candidate = path.with_name(f"{stem}_v{index}{path.suffix}")
        legacy = path.with_name(f"{stem} v{index}{path.suffix}")
        if not candidate.exists() and not legacy.exists():
            return candidate
    return path.with_name(f"{stem}_v999{path.suffix}")
