"""Content search tool with a pure-Python fallback."""

from __future__ import annotations

import asyncio
import re
import shutil
from pathlib import Path
from typing import Callable

from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.utils.windows_subprocess import hidden_subprocess_kwargs
from myharness.utils.process_tree import terminate_process_tree


class _RipgrepError(RuntimeError):
    """A search failed instead of returning a valid empty result."""


class GrepToolInput(BaseModel):
    """Arguments for the grep tool."""

    pattern: str = Field(description="Regular expression to search for")
    root: str | None = Field(default=None, description="Search root directory")
    file_glob: str = Field(default="**/*")
    case_sensitive: bool = Field(default=True)
    limit: int = Field(default=200, ge=1, le=2000)
    timeout_seconds: int = Field(default=20, ge=1, le=120)


class GrepTool(BaseTool):
    """Search text files for a regex pattern."""

    name = "grep"
    description = "Search file contents with a regular expression."
    input_model = GrepToolInput

    def is_read_only(self, arguments: GrepToolInput) -> bool:
        del arguments
        return True

    async def execute(self, arguments: GrepToolInput, context: ToolExecutionContext) -> ToolResult:
        try:
            return await self._execute_search(arguments, context)
        except (re.error, _RipgrepError, OSError) as exc:
            return ToolResult(output=f"Search failed: {exc}", is_error=True)

    async def _execute_search(self, arguments: GrepToolInput, context: ToolExecutionContext) -> ToolResult:
        root = _resolve_path(context.cwd, arguments.root) if arguments.root else context.cwd
        if not root.exists():
            return ToolResult(output=f"Search path does not exist: {root}. Use an existing file or directory as root; put file patterns in file_glob.", is_error=True)
        if not root.is_file() and not root.is_dir():
            return ToolResult(output=f"Search path is not a file or directory: {root}", is_error=True)
        if root.is_file():
            display_base = _display_base(root, context.cwd)
            matches = await _rg_grep_file(
                path=root,
                pattern=arguments.pattern,
                case_sensitive=arguments.case_sensitive,
                limit=arguments.limit,
                display_base=display_base,
                timeout_seconds=arguments.timeout_seconds,
            )
            if matches is not None:
                return _format_rg_result(matches, arguments.timeout_seconds)

            return ToolResult(
                output=_python_grep_files(
                    paths=[root],
                    pattern=arguments.pattern,
                    case_sensitive=arguments.case_sensitive,
                    limit=arguments.limit,
                    display_base=display_base,
                )
            )

        # Prefer ripgrep for performance; fallback to Python when unavailable.
        matches = await _rg_grep(
            root=root,
            pattern=arguments.pattern,
            file_glob=arguments.file_glob,
            case_sensitive=arguments.case_sensitive,
            limit=arguments.limit,
            timeout_seconds=arguments.timeout_seconds,
        )
        if matches is not None:
            return _format_rg_result(matches, arguments.timeout_seconds)

        # Python fallback (kept for portability).
        return ToolResult(
            output=_python_grep_files(
                paths=root.glob(arguments.file_glob),
                pattern=arguments.pattern,
                case_sensitive=arguments.case_sensitive,
                limit=arguments.limit,
                display_base=root,
            )
        )


def _display_base(path: Path, cwd: Path) -> Path:
    try:
        path.relative_to(cwd)
    except ValueError:
        return path.parent
    return cwd


def _python_grep_files(
    *,
    paths,
    pattern: str,
    case_sensitive: bool,
    limit: int,
    display_base: Path,
) -> str:
    # Python fallback (kept for portability).
    flags = 0 if case_sensitive else re.IGNORECASE
    compiled = re.compile(pattern, flags)
    collected: list[str] = []

    for path in paths:
        if len(collected) >= limit:
            break
        if not path.is_file():
            continue
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        if b"\x00" in raw:
            continue
        text = raw.decode("utf-8", errors="replace")
        for line_no, line in enumerate(text.splitlines(), start=1):
            if compiled.search(line):
                collected.append(f"{_format_path(path, display_base)}:{line_no}:{line}")
                if len(collected) >= limit:
                    break

    if not collected:
        return "(no matches)"
    return "\n".join(collected)


def _resolve_path(base: Path, candidate: str | None) -> Path:
    path = Path(candidate or ".").expanduser()
    if not path.is_absolute():
        path = base / path
    return path.resolve()


def _format_rg_result(matches: list[str], timeout_seconds: int, *, tool_name: str = "grep") -> ToolResult:
    timed_out = bool(matches and matches[-1] == _timeout_marker(timeout_seconds))
    rendered = matches[:-1] if timed_out else matches
    output = "\n".join(rendered) if rendered else "(no matches)"
    if timed_out:
        output = (
            f"{output}\n\n[{tool_name} timed out after {timeout_seconds} seconds]"
            if output != "(no matches)"
            else f"[{tool_name} timed out after {timeout_seconds} seconds]"
        )
    return ToolResult(output=output, is_error=timed_out)


async def _rg_grep(
    *,
    root: Path,
    pattern: str,
    file_glob: str,
    case_sensitive: bool,
    limit: int,
    timeout_seconds: int,
) -> list[str] | None:
    """Return matches using ripgrep, or None if ripgrep is unavailable."""
    rg = shutil.which("rg")
    if not rg:
        return None

    include_hidden = (root / ".git").exists() or (root / ".gitignore").exists()
    cmd: list[str] = [
        rg,
        "--no-heading",
        "--line-number",
        "--color",
        "never",
    ]
    if include_hidden:
        cmd.append("--hidden")
    if not case_sensitive:
        cmd.append("-i")
    if file_glob:
        cmd.extend(["--glob", file_glob])
    # `--` ensures patterns like `-foo` aren't parsed as flags.
    cmd.extend(["--", pattern, "."])

    return await _run_rg(
        cmd,
        cwd=root,
        limit=limit,
        timeout_seconds=timeout_seconds,
        format_match=_normalize_rg_match,
    )


async def _rg_grep_file(
    *,
    path: Path,
    pattern: str,
    case_sensitive: bool,
    limit: int,
    display_base: Path,
    timeout_seconds: int,
) -> list[str] | None:
    rg = shutil.which("rg")
    if not rg:
        return None

    cmd: list[str] = [
        rg,
        "--no-heading",
        "--line-number",
        "--color",
        "never",
    ]
    if not case_sensitive:
        cmd.append("-i")
    cmd.extend(["--", pattern, path.name])

    return await _run_rg(
        cmd,
        cwd=path.parent,
        limit=limit,
        timeout_seconds=timeout_seconds,
        format_match=lambda line: f"{_format_path(path, display_base)}:{line}",
    )


async def _run_rg(
    cmd: list[str],
    *,
    cwd: Path,
    limit: int,
    timeout_seconds: int,
    format_match: Callable[[str], str | None],
) -> list[str]:
    process = await _start_rg_process(cmd, cwd=cwd)
    matches: list[str] = []
    stderr_task = asyncio.create_task(_read_rg_stderr(process.stderr))
    stopped_early = False

    async def collect_and_wait() -> str:
        nonlocal stopped_early
        await _collect_rg_matches(process, matches, limit=limit, format_match=format_match)
        if len(matches) >= limit and process.returncode is None:
            stopped_early = True
            await _terminate_process(process)
        await process.wait()
        return await asyncio.shield(stderr_task)

    try:
        stderr = await asyncio.wait_for(collect_and_wait(), timeout=timeout_seconds)
    except asyncio.TimeoutError:
        matches.append(_timeout_marker(timeout_seconds))
        await _terminate_process(process)
        return matches
    except BaseException:
        await _terminate_process(process)
        raise
    finally:
        stderr_task.cancel()
        await asyncio.gather(stderr_task, return_exceptions=True)

    # rg exits 0 when matches are found, 1 when none are found.
    # A failed native search must not silently become a different Python search.
    if stopped_early or process.returncode in {0, 1}:
        return matches
    raise _RipgrepError(stderr.strip() or f"ripgrep exited with code {process.returncode}")


async def _read_rg_stderr(stream: asyncio.StreamReader | None) -> str:
    if stream is None:
        return ""
    tail = b""
    while chunk := await stream.read(64 * 1024):
        tail = (tail + chunk)[-16 * 1024:]
    return tail.decode("utf-8", errors="replace")


async def _start_rg_process(cmd: list[str], *, cwd: Path):
    from myharness.sandbox.session import get_docker_sandbox

    session = get_docker_sandbox()
    if session is not None and session.is_running:
        return await session.exec_command(
            cmd,
            cwd=cwd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

    return await asyncio.create_subprocess_exec(
        *cmd,
        cwd=str(cwd),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        limit=8 * 1024 * 1024,  # 8 MB per line avoids LimitOverrunError on long lines.
        **hidden_subprocess_kwargs(),
    )


def _timeout_marker(timeout_seconds: int) -> str:
    return f"__MYHARNESS_GREP_TIMEOUT__:{timeout_seconds}"


async def _collect_rg_matches(
    process: asyncio.subprocess.Process,
    matches: list[str],
    *,
    limit: int,
    format_match: Callable[[str], str | None],
) -> None:
    assert process.stdout is not None
    while len(matches) < limit:
        try:
            raw = await process.stdout.readline()
        except ValueError:
            # Line exceeded the stream buffer limit; skip it and continue.
            continue
        if not raw:
            break
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n")
        if not line:
            continue
        formatted = format_match(line)
        if formatted:
            matches.append(formatted)


async def _terminate_process(process: asyncio.subprocess.Process) -> None:
    await terminate_process_tree(process)


def _format_path(path: Path, display_base: Path) -> str:
    try:
        return path.relative_to(display_base).as_posix()
    except ValueError:
        return path.as_posix()


def _normalize_rg_match(line: str) -> str:
    match = re.match(r"^(.*?):(\d+):(.*)$", line)
    if not match:
        return line
    path, line_number, content = match.groups()
    path = path.replace("\\", "/").removeprefix("./")
    return f"{path}:{line_number}:{content}"
