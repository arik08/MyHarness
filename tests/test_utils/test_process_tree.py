"""Real inherited-pipe regressions for local command lifecycle paths."""

import asyncio
import ctypes
import os
import shlex
import subprocess
import time
from ctypes import wintypes

import pytest

from myharness.bridge.session_runner import spawn_session
from myharness.config import Settings
from myharness.tasks.manager import BackgroundTaskManager
from myharness.tools.base import ToolExecutionContext
from myharness.tools.bash_tool import BashTool, BashToolInput
from myharness.utils.process_tree import terminate_process_tree
from myharness.utils.shell import create_shell_subprocess
from myharness.utils.subprocess_output import communicate_bounded


@pytest.fixture
def command_tree(tmp_path, monkeypatch):
    monkeypatch.setattr("myharness.utils.shell.load_settings", lambda: Settings())
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    pid_file = tmp_path / "child.pid"
    script = tmp_path / "parent.py"
    script.write_text(
        "import subprocess, sys, time\n"
        "from pathlib import Path\n"
        "child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'])\n"
        "Path(sys.argv[1]).write_text(str(child.pid))\n"
        "print('parent-ready', flush=True)\n"
        "if sys.argv[2] == 'wait': time.sleep(60)\n",
        encoding="utf-8",
    )
    handles = []
    if os.name == "nt":
        api = ctypes.WinDLL("kernel32", use_last_error=True)
        api.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        api.OpenProcess.restype = wintypes.HANDLE
        api.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        api.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        api.CloseHandle.argtypes = [wintypes.HANDLE]

    def command(mode="wait"):
        args = ["python", str(script), str(pid_file), mode]
        return subprocess.list2cmdline(args) if os.name == "nt" else shlex.join(args)

    async def ready():
        async def read_pid():
            while not pid_file.exists() or not pid_file.read_text():
                await asyncio.sleep(0.01)
            return int(pid_file.read_text())
        pid = await asyncio.wait_for(read_pid(), 5)
        if os.name == "nt":
            handle = api.OpenProcess(0x100001, False, pid)  # SYNCHRONIZE | TERMINATE
            assert handle
            handles.append(handle)
            return lambda: api.WaitForSingleObject(handle, 0) == 0
        handles.append(pid)

        def exited():
            try:
                os.kill(pid, 0)
            except ProcessLookupError:
                return True
            from pathlib import Path
            stat = Path(f"/proc/{pid}/stat")
            return stat.exists() and stat.read_text().split(") ", 1)[1].startswith("Z")
        return exited

    yield command, ready
    for handle in handles:
        if os.name == "nt":
            if api.WaitForSingleObject(handle, 0) != 0:
                api.TerminateProcess(handle, 1)
            api.CloseHandle(handle)
        else:
            try:
                os.kill(handle, 9)
            except ProcessLookupError:
                pass


async def assert_exited(exited):
    async def poll():
        while not exited():
            await asyncio.sleep(0.01)
    await asyncio.wait_for(poll(), 2)


@pytest.mark.parametrize("mode", ["wait", "exit"])
async def test_bash_timeout_reaps_descendant_and_keeps_partial_output(command_tree, tmp_path, mode):
    command, ready = command_tree
    started = time.monotonic()
    task = asyncio.create_task(BashTool().execute(
        BashToolInput(command=command(mode), timeout_seconds=2),
        ToolExecutionContext(cwd=tmp_path),
    ))
    exited = await ready()
    result = await asyncio.wait_for(task, 6)
    assert result.metadata["timed_out"]
    assert "parent-ready" in result.output
    assert time.monotonic() - started < 6
    await assert_exited(exited)


@pytest.mark.parametrize("cancel", [False, True])
@pytest.mark.parametrize("mode", ["wait", "exit"])
async def test_communicate_reaps_descendant(command_tree, tmp_path, cancel, mode):
    command, ready = command_tree
    process = await create_shell_subprocess(
        command(mode), cwd=tmp_path, stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        exited = await ready()
        task = asyncio.create_task(communicate_bounded(process, timeout=0.2))
        if cancel:
            await asyncio.sleep(0.01)
            task.cancel()
        with pytest.raises(asyncio.CancelledError if cancel else asyncio.TimeoutError):
            await asyncio.wait_for(task, 5)
        await assert_exited(exited)
    finally:
        await terminate_process_tree(process)


@pytest.mark.parametrize("action", ["stop", "aclose", "close"])
async def test_background_shutdown_reaps_descendant(command_tree, tmp_path, action):
    command, ready = command_tree
    manager = BackgroundTaskManager()
    try:
        record = await manager.create_shell_task(
            command=command("exit"), cwd=tmp_path, description="tree regression",
        )
        exited = await ready()
        if action == "stop":
            await asyncio.wait_for(manager.stop_task(record.id), 5)
            assert manager.get_task(record.id).status == "killed"
        elif action == "aclose":
            await asyncio.wait_for(manager.aclose(), 5)
        else:
            manager.close()
        await assert_exited(exited)
    finally:
        await manager.aclose()


async def test_bridge_kill_reaps_descendant_after_parent_exit(command_tree, tmp_path):
    command, ready = command_tree
    handle = await spawn_session(session_id="tree-test", command=command("exit"), cwd=tmp_path)
    try:
        exited = await ready()
        await asyncio.wait_for(handle.kill(), 5)
        await assert_exited(exited)
    finally:
        await handle.kill()


async def test_failed_reap_is_bounded(monkeypatch):
    from unittest.mock import Mock
    from myharness.utils import process_tree

    class Process:
        kill = Mock()
        _transport = Mock()

        async def wait(self):
            await asyncio.Event().wait()

    monkeypatch.setattr(process_tree, "PROCESS_REAP_TIMEOUT", 0.01)
    process = Process()
    await asyncio.wait_for(terminate_process_tree(process), 0.5)
    process.kill.assert_called_once()
    process._transport.close.assert_called_once()


async def test_bash_cancellation_reaps_descendant(command_tree, tmp_path):
    command, ready = command_tree
    task = asyncio.create_task(BashTool().execute(
        BashToolInput(command=command(), timeout_seconds=60), ToolExecutionContext(cwd=tmp_path),
    ))
    exited = await ready()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(task, 5)
    await assert_exited(exited)


@pytest.mark.skipif(os.name != "nt", reason="Windows Job Object lifecycle")
async def test_normal_exit_releases_job(tmp_path):
    process = await create_shell_subprocess("python -c 'print(123)'", cwd=tmp_path, settings=Settings())
    await asyncio.wait_for(process.wait(), 5)
    await asyncio.sleep(0)
    assert process._myharness_job.handle is None


@pytest.mark.skipif(os.name != "nt", reason="Windows suspended process setup")
async def test_job_assignment_failure_reaps_suspended_process(tmp_path, monkeypatch):
    from myharness.utils.windows_job import WindowsJob
    from myharness.utils import shell

    processes = []
    create = asyncio.create_subprocess_exec

    async def record(*args, **kwargs):
        process = await create(*args, **kwargs)
        processes.append(process)
        return process

    def fail(self, pid):
        raise OSError("job assignment failed")

    monkeypatch.setattr(shell.asyncio, "create_subprocess_exec", record)
    monkeypatch.setattr(WindowsJob, "attach_and_resume", fail)
    with pytest.raises(OSError, match="job assignment failed"):
        await asyncio.wait_for(create_shell_subprocess(
            "python -c 'import time; time.sleep(60)'", cwd=tmp_path, settings=Settings(),
        ), 5)
    assert len(processes) == 1
    assert processes[0].returncode is not None


def test_only_owned_posix_group_is_signalled(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from myharness.utils import process_tree

    killpg = Mock()
    monkeypatch.setattr(process_tree.os, "killpg", killpg, raising=False)
    monkeypatch.setattr(process_tree.signal, "SIGKILL", 9, raising=False)
    owned = SimpleNamespace(_myharness_process_group=123, kill=Mock(), returncode=0)
    process_tree.kill_process_tree(owned)
    killpg.assert_called_once_with(123, 9)
    owned.kill.assert_not_called()
    unowned = SimpleNamespace(kill=Mock())
    process_tree.kill_process_tree(unowned)
    unowned.kill.assert_called_once()
    assert killpg.call_count == 1
