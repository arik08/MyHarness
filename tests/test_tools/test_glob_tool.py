import asyncio
import shutil
import sys
import threading

import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools.glob_tool import GlobTool, GlobToolInput


@pytest.mark.asyncio
@pytest.mark.parametrize("pattern", ["*", "**/*"])
@pytest.mark.parametrize("fallback", [False, True])
async def test_glob_lists_only_files(tmp_path, monkeypatch, pattern, fallback):
    if not fallback and not shutil.which("rg"):
        pytest.skip("ripgrep is not installed")
    (tmp_path / "folder.txt").mkdir()
    (tmp_path / "file.txt").write_text("data")
    if fallback:
        monkeypatch.setattr("myharness.tools.glob_tool.shutil.which", lambda _: None)
    result = await GlobTool().execute(GlobToolInput(pattern=pattern), ToolExecutionContext(cwd=tmp_path))
    assert not result.is_error
    assert result.output == "file.txt"


@pytest.mark.asyncio
@pytest.mark.parametrize("root", ["missing", "file.txt"])
async def test_invalid_root_is_error(tmp_path, root):
    (tmp_path / "file.txt").write_text("data")
    result = await GlobTool().execute(GlobToolInput(root=root, pattern="*"), ToolExecutionContext(cwd=tmp_path))
    assert result.is_error


@pytest.mark.asyncio
@pytest.mark.parametrize("pattern", ["", "/absolute/*", "C:/absolute/*", "C:relative/*", "\\rooted\\*"])
async def test_nonrelative_pattern_is_actionable_error(tmp_path, pattern):
    result = await GlobTool().execute(GlobToolInput(pattern=pattern), ToolExecutionContext(cwd=tmp_path))
    assert result.is_error
    assert "root" in result.output and "pattern" in result.output


@pytest.mark.asyncio
async def test_glob_reports_ripgrep_failure(tmp_path, monkeypatch):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import sys; sys.stderr.write('invalid glob pattern'); sys.exit(2)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    async def start(*args, **kwargs):
        return process
    monkeypatch.setattr("myharness.tools.glob_tool.shutil.which", lambda _: "rg")
    monkeypatch.setattr("asyncio.create_subprocess_exec", start)
    result = await GlobTool().execute(GlobToolInput(pattern="**/*"), ToolExecutionContext(cwd=tmp_path))
    assert result.is_error
    assert "invalid glob pattern" in result.output


@pytest.mark.asyncio
async def test_glob_timeout_reaps_process(tmp_path, monkeypatch):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time; time.sleep(60)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    async def start(*args, **kwargs):
        return process
    monkeypatch.setattr("myharness.tools.glob_tool.shutil.which", lambda _: "rg")
    monkeypatch.setattr("asyncio.create_subprocess_exec", start)
    try:
        result = await asyncio.wait_for(GlobTool().execute(GlobToolInput(pattern="**/*", timeout_seconds=1), ToolExecutionContext(cwd=tmp_path)), timeout=4)
        assert result.is_error
        assert "glob timed out" in result.output
        assert process.returncode is not None
    finally:
        if process.returncode is None:
            process.kill()
        await process.communicate()


@pytest.mark.asyncio
@pytest.mark.parametrize("cancel", [False, True])
async def test_fallback_remains_responsive_and_stops_worker(tmp_path, monkeypatch, cancel):
    started = asyncio.Event()
    finished = threading.Event()
    loop = asyncio.get_running_loop()
    def slow_glob(root, pattern, limit, stopped):
        loop.call_soon_threadsafe(started.set)
        assert stopped.wait(4), "worker did not receive stop signal"
        finished.set()
        return []
    monkeypatch.setattr("myharness.tools.glob_tool.shutil.which", lambda _: None)
    monkeypatch.setattr("myharness.tools.glob_tool._python_glob", slow_glob)
    task = asyncio.create_task(GlobTool().execute(GlobToolInput(pattern="**/*", timeout_seconds=1), ToolExecutionContext(cwd=tmp_path)))
    await asyncio.wait_for(started.wait(), timeout=2)
    if cancel:
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        result = await asyncio.wait_for(task, timeout=3)
        assert result.is_error and "glob timed out" in result.output
    assert await asyncio.to_thread(finished.wait, 2)


@pytest.mark.asyncio
async def test_fallback_limit_counts_files_and_sorts_results(tmp_path, monkeypatch):
    for name in ["z.txt", "b.txt", "a.txt"]:
        (tmp_path / name).write_text("data")
    (tmp_path / "0-folder").mkdir()
    monkeypatch.setattr("myharness.tools.glob_tool.shutil.which", lambda _: None)
    result = await GlobTool().execute(GlobToolInput(pattern="*", limit=2), ToolExecutionContext(cwd=tmp_path))
    assert result.output == "a.txt\nb.txt"
