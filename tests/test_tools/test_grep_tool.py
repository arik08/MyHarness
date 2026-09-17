import asyncio
import shutil
import sys
from pathlib import Path

import pytest

from myharness.tools.grep_tool import GrepTool, GrepToolInput
from myharness.tools.grep_tool import _normalize_rg_match
from myharness.tools.grep_tool import _run_rg, _format_rg_result


@pytest.mark.parametrize("raw,expected", [
    (r'.\nested\data.json:12:{"path":"C:\\work\\new"}', r'nested/data.json:12:{"path":"C:\\work\\new"}'),
    (r'./src/a.py:2:pattern = r"\d+\s"', r'src/a.py:2:pattern = r"\d+\s"'),
    (r'.\a.txt:7:   \keep trailing\ ', r'a.txt:7:   \keep trailing\ '),
])
def test_search_normalizes_only_filename(raw, expected):
    assert _normalize_rg_match(raw) == expected


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback", [False, True])
@pytest.mark.parametrize("file_root", [False, True])
async def test_search_returns_original_content_with_real_files(tmp_path, monkeypatch, fallback, file_root):
    if not fallback and not shutil.which("rg"):
        pytest.skip("ripgrep is not installed")
    path = tmp_path / "nested" / "sample.txt"
    path.parent.mkdir()
    content = r'  pattern = r"\d+\s"; path = "C:\\work\\new"  '
    path.write_bytes((content + "\r\n").encode())
    if fallback:
        monkeypatch.setattr("myharness.tools.grep_tool.shutil.which", lambda _: None)
    result = await GrepTool().execute(
        GrepToolInput(pattern="pattern", root=str(path) if file_root else str(tmp_path)),
        type("Ctx", (), {"cwd": tmp_path})(),
    )
    assert not result.is_error
    assert result.output == f"nested/sample.txt:1:{content}"


@pytest.mark.asyncio
@pytest.mark.parametrize("fallback", [False, True])
async def test_invalid_regex_is_a_tool_error(tmp_path, monkeypatch, fallback):
    if not fallback and not shutil.which("rg"):
        pytest.skip("ripgrep is not installed")
    (tmp_path / "a.txt").write_text("sample")
    if fallback:
        monkeypatch.setattr("myharness.tools.grep_tool.shutil.which", lambda _: None)
    result = await GrepTool().execute(GrepToolInput(pattern="["), type("Ctx", (), {"cwd": tmp_path})())
    assert result.is_error
    assert result.output != "(no matches)"


@pytest.mark.asyncio
async def test_timeout_includes_process_exit_after_stdout_closes(tmp_path, monkeypatch):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import os,time; os.close(1); time.sleep(60)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    async def start(*args, **kwargs):
        return process
    monkeypatch.setattr("myharness.tools.grep_tool._start_rg_process", start)
    try:
        matches = await asyncio.wait_for(_run_rg([], cwd=tmp_path, limit=5, timeout_seconds=1, format_match=str), timeout=4)
        assert _format_rg_result(matches, 1).is_error
        assert process.returncode is not None
    finally:
        if process.returncode is None:
            process.kill()
        await process.communicate()


@pytest.mark.asyncio
async def test_large_stderr_is_drained_and_reported(tmp_path, monkeypatch):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import sys; sys.stderr.write('x'*200000+' error detail'); sys.exit(2)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    async def start(*args, **kwargs):
        return process
    monkeypatch.setattr("myharness.tools.grep_tool._start_rg_process", start)
    monkeypatch.setattr("myharness.tools.grep_tool.shutil.which", lambda _: "rg")
    try:
        result = await asyncio.wait_for(GrepTool().execute(GrepToolInput(pattern="sample", timeout_seconds=1), type("Ctx", (), {"cwd": tmp_path})()), timeout=4)
        assert result.is_error
        assert "error detail" in result.output
        assert len(result.output) < 17000
    finally:
        if process.returncode is None:
            process.kill()
        await process.communicate()


@pytest.mark.asyncio
async def test_cancellation_reaps_active_search_process(tmp_path, monkeypatch):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import time; time.sleep(60)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    started = asyncio.Event()
    async def start(*args, **kwargs):
        started.set()
        return process
    monkeypatch.setattr("myharness.tools.grep_tool._start_rg_process", start)
    task = asyncio.create_task(_run_rg([], cwd=tmp_path, limit=5, timeout_seconds=20, format_match=str))
    try:
        await started.wait()
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await asyncio.wait_for(task, timeout=4)
        assert process.returncode is not None
    finally:
        if process.returncode is None:
            process.kill()
        await process.communicate()


@pytest.mark.asyncio
async def test_limit_returns_matches_without_waiting_for_search_exit(tmp_path, monkeypatch):
    process = await asyncio.create_subprocess_exec(
        sys.executable, "-c", "import sys,time; print('one'); print('two'); sys.stdout.flush(); time.sleep(60)",
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    async def start(*args, **kwargs):
        return process
    monkeypatch.setattr("myharness.tools.grep_tool._start_rg_process", start)
    try:
        matches = await asyncio.wait_for(_run_rg([], cwd=tmp_path, limit=2, timeout_seconds=20, format_match=str), timeout=4)
        assert matches == ["one", "two"]
        assert process.returncode is not None
    finally:
        if process.returncode is None:
            process.kill()
        await process.communicate()


class _FakeStdout:
    async def readline(self):
        await asyncio.sleep(60)
        return b""


class _ValueErrorThenEofStdout:
    def __init__(self):
        self.calls = 0

    async def readline(self):
        self.calls += 1
        if self.calls == 1:
            raise ValueError("Separator is not found, and chunk exceed the limit")
        return b""


class _LinesStdout:
    def __init__(self, lines):
        self._lines = list(lines)

    async def readline(self):
        if self._lines:
            return self._lines.pop(0)
        return b""


class _FakeProcess:
    def __init__(self, stdout=None):
        self.stdout = stdout or _FakeStdout()
        self.stderr = None
        self.returncode = None
        self.terminated = False
        self.killed = False

    def terminate(self):
        self.terminated = True
        self.returncode = -15

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        return self.returncode


@pytest.mark.asyncio
@pytest.mark.parametrize("root", ["missing", "src/*.py", "gone/file.txt"])
async def test_grep_invalid_root_returns_actionable_error_without_spawning(tmp_path, monkeypatch, root):
    async def unexpected_spawn(*args, **kwargs):
        pytest.fail("invalid root must not spawn ripgrep")
    monkeypatch.setattr("myharness.tools.grep_tool._start_rg_process", unexpected_spawn)
    result = await GrepTool().execute(
        GrepToolInput(pattern="example", root=root), type("Ctx", (), {"cwd": tmp_path})(),
    )
    assert result.is_error
    assert "Search path does not exist" in result.output
    assert "file_glob" in result.output


@pytest.mark.asyncio
async def test_grep_tool_returns_timeout_error(monkeypatch, tmp_path: Path):
    tool = GrepTool()
    monkeypatch.setattr("myharness.tools.grep_tool.shutil.which", lambda _: "/usr/bin/rg")
    fake_process = _FakeProcess()

    async def fake_create_subprocess_exec(*args, **kwargs):
        return fake_process

    monkeypatch.setattr(
        "myharness.tools.grep_tool.asyncio.create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await tool.execute(
        GrepToolInput(pattern="foo", timeout_seconds=1),
        type("Ctx", (), {"cwd": tmp_path})(),
    )

    assert result.is_error is True
    assert "grep timed out after 1 seconds" in result.output
    assert fake_process.terminated or fake_process.killed


@pytest.mark.asyncio
async def test_grep_tool_uses_large_stream_limit_and_skips_valueerror(monkeypatch, tmp_path: Path):
    tool = GrepTool()
    monkeypatch.setattr("myharness.tools.grep_tool.shutil.which", lambda _: "/usr/bin/rg")
    fake_process = _FakeProcess(stdout=_ValueErrorThenEofStdout())
    seen_kwargs = {}

    async def fake_create_subprocess_exec(*args, **kwargs):
        seen_kwargs.update(kwargs)
        fake_process.returncode = 1
        return fake_process

    monkeypatch.setattr(
        "myharness.tools.grep_tool.asyncio.create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await tool.execute(
        GrepToolInput(pattern="foo"),
        type("Ctx", (), {"cwd": tmp_path})(),
    )

    assert result.is_error is False
    assert result.output == "(no matches)"
    assert seen_kwargs["limit"] == 8 * 1024 * 1024


@pytest.mark.asyncio
async def test_grep_file_normalizes_crlf_rg_output(monkeypatch, tmp_path: Path):
    target = tmp_path / "notes.txt"
    target.write_text("foo\n", encoding="utf-8")
    tool = GrepTool()
    monkeypatch.setattr("myharness.tools.grep_tool.shutil.which", lambda _: "/usr/bin/rg")
    fake_process = _FakeProcess(stdout=_LinesStdout([b"1:foo\r\n"]))

    async def fake_create_subprocess_exec(*args, **kwargs):
        fake_process.returncode = 0
        return fake_process

    monkeypatch.setattr(
        "myharness.tools.grep_tool.asyncio.create_subprocess_exec",
        fake_create_subprocess_exec,
    )

    result = await tool.execute(
        GrepToolInput(pattern="foo", root=str(target)),
        type("Ctx", (), {"cwd": tmp_path})(),
    )

    assert result.output == "notes.txt:1:foo"
