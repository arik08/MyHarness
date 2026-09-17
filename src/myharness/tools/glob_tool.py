"""Filesystem globbing tool."""

from __future__ import annotations

import asyncio
import heapq
import shutil
import threading
from pathlib import Path, PurePosixPath, PureWindowsPath

from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.tools.grep_tool import _RipgrepError, _run_rg, _timeout_marker, _format_rg_result


class GlobToolInput(BaseModel):
    """Arguments for the glob tool."""

    pattern: str = Field(description="Glob pattern relative to the working directory")
    root: str | None = Field(default=None, description="Optional search root")
    limit: int = Field(default=200, ge=1, le=5000)
    timeout_seconds: int = Field(default=20, ge=1, le=120)


class GlobTool(BaseTool):
    """List files matching a glob pattern."""

    name = "glob"
    description = "List files matching a glob pattern."
    input_model = GlobToolInput

    def is_read_only(self, arguments: GlobToolInput) -> bool:
        del arguments
        return True

    async def execute(self, arguments: GlobToolInput, context: ToolExecutionContext) -> ToolResult:
        root = _resolve_path(context.cwd, arguments.root) if arguments.root else context.cwd
        if not arguments.pattern or PureWindowsPath(arguments.pattern).anchor or PurePosixPath(arguments.pattern).anchor:
            return ToolResult(output="Use a relative pattern and put the search directory in root.", is_error=True)
        if not root.is_dir():
            return ToolResult(output=f"Search root is not an existing directory: {root}", is_error=True)
        try:
            matches = await _glob(root, arguments.pattern, limit=arguments.limit, timeout_seconds=arguments.timeout_seconds)
        except asyncio.TimeoutError:
            return ToolResult(output=f"[glob timed out after {arguments.timeout_seconds} seconds]", is_error=True)
        except (OSError, ValueError, _RipgrepError) as exc:
            return ToolResult(output=f"File search failed: {exc}", is_error=True)
        return _format_rg_result(matches, arguments.timeout_seconds, tool_name="glob")


def _resolve_path(base: Path, candidate: str | None) -> Path:
    path = Path(candidate or ".").expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _looks_like_git_repo(path: Path) -> bool:
    """Heuristic: determine whether we should include hidden paths when searching.

    For codebases, hidden dirs like `.github/` are relevant; for arbitrary dirs
    (like a user's home), searching hidden paths can explode the search space.
    """
    current = path
    for _ in range(6):
        git_dir = current / ".git"
        if git_dir.exists():
            return True
        if current.parent == current:
            break
        current = current.parent
    return False


async def _glob(root: Path, pattern: str, *, limit: int, timeout_seconds: int = 20) -> list[str]:
    """Fast glob implementation.

    Uses ripgrep's file walker when available (respects .gitignore and can skip
    heavy directories like `.venv/`), with a Python fallback.
    """
    rg = shutil.which("rg")
    # `Path.glob("**/*")` will traverse hidden and ignored paths (like `.venv/`)
    # and can be very slow on real workspaces. Prefer `rg --files`.
    if rg and ("**" in pattern or "/" in pattern):
        include_hidden = _looks_like_git_repo(root)
        cmd = [rg, "--files"]
        if include_hidden:
            cmd.append("--hidden")
        cmd.extend(["--glob", pattern, "."])

        lines = await _run_rg(
            cmd, cwd=root, limit=limit, timeout_seconds=timeout_seconds,
            format_match=_display_path,
        )
        timed_out = bool(lines and lines[-1] == _timeout_marker(timeout_seconds))
        if timed_out:
            lines.pop()
        # Sorting keeps unit tests and user output deterministic for small results.
        lines.sort()
        if timed_out:
            lines.append(_timeout_marker(timeout_seconds))
        return lines

    # Keep slow filesystem traversal off the event loop and stop cooperatively
    # when the caller cancels or its time budget expires.
    stopped = threading.Event()
    try:
        return await asyncio.wait_for(
            asyncio.to_thread(_python_glob, root, pattern, limit, stopped),
            timeout=timeout_seconds,
        )
    finally:
        stopped.set()


def _python_glob(root: Path, pattern: str, limit: int, stopped: threading.Event) -> list[str]:
    def files():
        for path in root.glob(pattern):
            if stopped.is_set():
                break
            if path.is_file():
                yield path.relative_to(root).as_posix()
    return heapq.nsmallest(limit, files())


def _display_path(path: str) -> str:
    return path.replace("\\", "/").removeprefix("./")
