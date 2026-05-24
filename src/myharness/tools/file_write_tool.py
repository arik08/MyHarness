"""File writing tool."""

from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.mermaid_preflight import (
    format_mermaid_preflight_errors,
    mermaid_preflight_errors,
)
from myharness.tools.path_display import display_tool_path
from myharness.services.token_estimation import estimate_tokens


class FileWriteToolInput(BaseModel):
    """Arguments for the file write tool."""

    path: str = Field(description="Path of the file to write")
    content: str = Field(description="Full file contents")
    create_directories: bool = Field(default=True)


class FileWriteTool(BaseTool):
    """Write complete file contents."""

    name = "write_file"
    description = (
        "Create or intentionally overwrite a complete text file in the local repository. "
        "For changes to an existing file, prefer read_file followed by edit_file unless a full rewrite is clearly intended. "
        "Use `write_file` for direct coherent report artifacts, including explicit 24k, 32k, or 40k targets while the long-report section-merge flow is disabled. "
        "For report artifacts, surface research, analysis, outline, data, chart, or synthesis progress before this tool call; once this tool starts, the UI can already stream the file content preview. "
        "For new standalone artifacts, prefer an `outputs/` relative path; keep files that reference each other in the same subfolder. "
        "For human-facing HTML, Markdown, PDF, DOCX, XLSX, and PPTX artifacts, prefer concise readable Korean filenames with underscores between words when the user/content is Korean; "
        "English snake/kebab-style filenames are fine for code, scripts, configs, and data such as PY, JS, JSON, or CSV. "
        "Avoid generic names like index.html for newly created artifacts unless the user explicitly asks for that name "
        "or a required app/framework/hosting entrypoint would otherwise break."
    )
    input_model = FileWriteToolInput

    async def execute(
        self,
        arguments: FileWriteToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        path = _resolve_path(context.cwd, arguments.path)

        from myharness.sandbox.session import is_docker_sandbox_active

        if is_docker_sandbox_active():
            from myharness.sandbox.path_validator import validate_sandbox_path

            allowed, reason = validate_sandbox_path(path, context.cwd)
            if not allowed:
                return ToolResult(output=f"Sandbox: {reason}", is_error=True)

        if arguments.create_directories:
            path.parent.mkdir(parents=True, exist_ok=True)
        mermaid_errors = mermaid_preflight_errors(path, arguments.content)
        if mermaid_errors:
            return ToolResult(
                output=format_mermaid_preflight_errors(path, mermaid_errors, action="written"),
                is_error=True,
            )
        path.write_text(arguments.content, encoding="utf-8")
        display_path = display_tool_path(path, context.cwd)
        output = f"Wrote {display_path}"
        target_note = _target_length_feedback(arguments.content, path, context)
        if not target_note:
            return ToolResult(output=output)
        return ToolResult(
            output=output,
            metadata={
                "model_output": f"{output}\n\n{target_note}",
                "display_output": output,
                "transcript_output": output,
            },
        )


def _resolve_path(base: Path, candidate: str) -> Path:
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _target_length_feedback(content: str, path: Path, context: ToolExecutionContext) -> str:
    if path.suffix.lower() not in {".html", ".htm", ".md", ".markdown", ".txt"}:
        return ""
    try:
        target_tokens = int(context.metadata.get("compose_target_output_tokens") or 0)
        floor_tokens = int(context.metadata.get("compose_target_output_floor_tokens") or 0)
    except (TypeError, ValueError):
        return ""
    if target_tokens <= 0:
        return ""
    if floor_tokens <= 0:
        floor_tokens = int(target_tokens * 0.8)
    model = str(context.metadata.get("model") or "")
    estimated_tokens = estimate_tokens(content, model=model)
    if estimated_tokens >= floor_tokens:
        return ""
    missing_tokens = max(0, target_tokens - estimated_tokens)
    return (
        "[Target length check]\n"
        f"The selected artifact target is about {target_tokens:,} tokens, with a minimum acceptable floor of about {floor_tokens:,} tokens. "
        f"The file you just wrote is estimated at only {estimated_tokens:,} tokens, which is below the selected target. "
        f"Expand the same artifact by calling `write_file` again on the same path with the complete revised file content. "
        f"Add roughly {missing_tokens:,} tokens of substantive analysis, explanations, tables, chart-support notes, source notes, and interpretation. "
        "Do not send the final answer yet unless the source material is genuinely too thin; if it is too thin, state that clearly in the final answer."
    )

