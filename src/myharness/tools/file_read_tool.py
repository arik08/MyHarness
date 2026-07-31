"""File reading tool."""

from __future__ import annotations

import asyncio
from pathlib import Path

from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.path_display import display_tool_path

FILE_READ_MAX_OUTPUT_CHARS = 1024 * 1024
FILE_READ_TRUNCATION_NOTICE = "\n... (read_file output truncated at 1 MiB)"


class FileReadToolInput(BaseModel):
    """Arguments for the file read tool."""

    path: str = Field(description="Path of the file to read")
    offset: int = Field(default=0, ge=0, description="Zero-based starting line")
    limit: int = Field(default=200, ge=1, le=2000, description="Number of lines to return")


class FileReadTool(BaseTool):
    """Read a UTF-8 text file with line numbers."""

    name = "read_file"
    description = "Read a text file from the local repository."
    input_model = FileReadToolInput

    def is_read_only(self, arguments: FileReadToolInput) -> bool:
        del arguments
        return True

    async def execute(
        self,
        arguments: FileReadToolInput,
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
        if path.is_dir():
            return ToolResult(output=f"디렉터리는 읽을 수 없습니다: {display_tool_path(path, context.cwd)}", is_error=True)

        is_binary, selected = await asyncio.to_thread(
            _read_selected_lines,
            path,
            arguments.offset,
            arguments.limit,
        )
        if is_binary:
            return ToolResult(
                output=f"바이너리 파일은 텍스트로 읽을 수 없습니다: {display_tool_path(path, context.cwd)}",
                is_error=True,
            )

        numbered = [
            f"{arguments.offset + index + 1:>6}\t{line}"
            for index, line in enumerate(selected)
        ]
        if not numbered:
            return ToolResult(
                output=f"(선택한 범위에 내용이 없습니다: {display_tool_path(path, context.cwd)})"
            )
        output = "\n".join(numbered)
        if len(output) > FILE_READ_MAX_OUTPUT_CHARS:
            output = output[:FILE_READ_MAX_OUTPUT_CHARS] + FILE_READ_TRUNCATION_NOTICE
        return ToolResult(output=output)


def _resolve_path(base: Path, candidate: str) -> Path:
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _read_selected_lines(path: Path, offset: int, limit: int) -> tuple[bool, list[str]]:
    selected: list[str] = []
    end = offset + limit
    with path.open("r", encoding="utf-8", errors="replace", newline=None) as handle:
        for index, line in enumerate(handle):
            if "\x00" in line:
                return True, []
            if offset <= index < end:
                selected.append(line.rstrip("\r\n"))
    return False, selected
