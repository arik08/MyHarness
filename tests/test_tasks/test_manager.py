"""Tests for background task management."""

from __future__ import annotations

import asyncio
import shlex
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

import myharness.tasks.manager as task_manager_module
from myharness.tasks.manager import TASK_PROGRESS_EVENT_PREFIX
from myharness.tasks.manager import BackgroundTaskManager
from myharness.tasks.types import TaskRecord


def _python_stdout_command(text: str) -> str:
    code = f"import sys; sys.stdout.write({text!r})"
    if sys.platform == "win32":
        return f"& {sys.executable!r} -c {code!r}"
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


def _python_stdin_echo_command() -> str:
    code = "import sys; line=sys.stdin.readline().rstrip('\\n'); print('got:' + line)"
    if sys.platform == "win32":
        return f"& {sys.executable!r} -u -c {code!r}"
    return f"{shlex.quote(sys.executable)} -u -c {shlex.quote(code)}"


@pytest.mark.asyncio
async def test_create_shell_task_and_read_output(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_shell_task(
        command=_python_stdout_command("hello task"),
        description="hello",
        cwd=tmp_path,
    )

    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]
    updated = manager.get_task(task.id)
    assert updated is not None
    assert updated.status == "completed"
    assert "hello task" in manager.read_task_output(task.id)


@pytest.mark.asyncio
async def test_task_update_listener_fires_for_output_and_completion(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()
    updates: list[tuple[str, str]] = []

    def _listener(task):
        updates.append((task.id, task.status))

    manager.register_update_listener(_listener)
    task = await manager.create_shell_task(
        command=_python_stdout_command("hello task"),
        description="hello",
        cwd=tmp_path,
    )

    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]

    assert (task.id, "running") in updates
    assert (task.id, "completed") in updates


@pytest.mark.asyncio
async def test_child_task_update_control_line_updates_parent_metadata(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_shell_task(
        command=_python_stdout_command(""),
        description="worker",
        cwd=tmp_path,
        task_type="local_agent",
        env={"MYHARNESS_PARENT_TASK_ID": "{task_id}"},
    )

    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]
    payload = (
        f"{TASK_PROGRESS_EVENT_PREFIX}"
        f'{{"task_id":"{task.id}","progress":35,"status_note":"checking sources"}}\n'
        "visible result\n"
    )
    visible = manager._filter_control_output(task.id, payload.encode("utf-8"))  # type: ignore[attr-defined]
    updated = manager.get_task(task.id)

    assert updated is not None
    assert updated.env["MYHARNESS_PARENT_TASK_ID"] == task.id
    assert updated.metadata["progress"] == "35"
    assert updated.metadata["status_note"] == "checking sources"
    assert float(updated.metadata["status_note_updated_at"]) > 0
    assert visible == b"visible result\n"


@pytest.mark.asyncio
async def test_create_agent_task_with_command_override_and_write(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_agent_task(
        prompt="first",
        description="agent",
        cwd=tmp_path,
        command=_python_stdin_echo_command(),
    )

    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]
    assert "got:first" in manager.read_task_output(task.id)


@pytest.mark.asyncio
async def test_create_agent_task_expands_task_id_placeholder(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_agent_task(
        prompt="task={task_id}",
        description="agent",
        cwd=tmp_path,
        command=_python_stdin_echo_command(),
    )

    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]
    assert task.prompt == f"task={task.id}"
    assert f"got:task={task.id}" in manager.read_task_output(task.id)


@pytest.mark.asyncio
async def test_write_to_stopped_agent_task_restarts_process(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_agent_task(
        prompt="ready",
        description="agent",
        cwd=tmp_path,
        command=_python_stdin_echo_command(),
    )
    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]

    await manager.write_to_task(task.id, "follow-up")
    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]

    output = manager.read_task_output(task.id)
    assert "got:ready" in output
    assert "got:follow-up" in output
    updated = manager.get_task(task.id)
    assert updated is not None
    assert updated.metadata["restart_count"] == "1"


@pytest.mark.asyncio
async def test_stop_task(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_shell_task(
        command="sleep 30",
        description="sleeper",
        cwd=tmp_path,
    )
    await manager.stop_task(task.id)
    updated = manager.get_task(task.id)
    assert updated is not None
    assert updated.status == "killed"


@pytest.mark.asyncio
async def test_read_task_output_returns_empty_string_when_log_file_is_missing(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_shell_task(
        command=_python_stdout_command("short lived"),
        description="missing output",
        cwd=tmp_path,
    )
    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]
    task.output_file.unlink()

    assert manager.read_task_output(task.id) == ""


@pytest.mark.asyncio
async def test_read_task_output_returns_empty_string_for_non_positive_max_bytes(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    task = await manager.create_shell_task(
        command=_python_stdout_command("visible output"),
        description="zero tail",
        cwd=tmp_path,
    )
    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]

    assert manager.read_task_output(task.id, max_bytes=0) == ""
    assert manager.read_task_output(task.id, max_bytes=-1) == ""


@pytest.mark.asyncio
async def test_read_task_output_reads_only_requested_file_tail(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()
    task = await manager.create_shell_task(
        command=_python_stdout_command("seed"),
        description="large output tail",
        cwd=tmp_path,
    )
    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]
    task.output_file.write_bytes(b"x" * (2 * 1024 * 1024) + b"final-tail")

    output = manager.read_task_output(task.id, max_bytes=64)

    assert output.endswith("final-tail")
    assert len(output.encode("utf-8")) <= 64


@pytest.mark.asyncio
async def test_task_output_rotation_bounds_disk_and_reads_across_latest_files(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setattr(task_manager_module, "TASK_OUTPUT_MAX_BYTES", 64)
    manager = BackgroundTaskManager()
    task = await manager.create_shell_task(
        command=_python_stdout_command("seed"),
        description="bounded output",
        cwd=tmp_path,
    )
    await asyncio.wait_for(manager._waiters[task.id], timeout=5)  # type: ignore[attr-defined]

    task.output_file.write_bytes(b"A" * 40)
    task_manager_module._append_task_output(task.output_file, b"B" * 40)
    task_manager_module._append_task_output(task.output_file, b"C" * 40)

    backup = task.output_file.with_name(f"{task.output_file.name}.1")
    assert task.output_file.stat().st_size <= 64
    assert backup.stat().st_size <= 64
    assert manager.read_task_output(task.id, max_bytes=64) == "B" * 24 + "C" * 40


@pytest.mark.asyncio
async def test_copy_output_coalesces_fast_listener_updates(tmp_path: Path, monkeypatch) -> None:
    class _ChunkReader:
        def __init__(self, count: int) -> None:
            self.remaining = count

        async def read(self, size: int) -> bytes:
            if self.remaining <= 0:
                return b""
            self.remaining -= 1
            return b"x" * (size - 1) + b"\n"

    monkeypatch.setattr(task_manager_module, "TASK_OUTPUT_NOTIFY_INTERVAL_SECONDS", 3600)
    manager = BackgroundTaskManager()
    notifications = 0

    def _listener(task: TaskRecord) -> None:
        nonlocal notifications
        del task
        notifications += 1

    manager.register_update_listener(_listener)
    output_path = tmp_path / "coalesced.log"
    output_path.write_bytes(b"")
    record = TaskRecord(
        id="coalesced",
        type="local_bash",
        status="running",
        description="coalesced output",
        cwd=str(tmp_path),
        output_file=output_path,
    )
    manager._tasks[record.id] = record  # type: ignore[attr-defined]
    manager._output_locks[record.id] = asyncio.Lock()  # type: ignore[attr-defined]

    await manager._copy_output(  # type: ignore[attr-defined]
        record.id,
        SimpleNamespace(stdout=_ChunkReader(100)),
    )

    assert output_path.stat().st_size == 100 * task_manager_module.TASK_OUTPUT_READ_CHUNK_BYTES
    assert notifications == 1


@pytest.mark.asyncio
async def test_create_shell_task_marks_record_failed_when_process_start_fails(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()

    with pytest.raises(OSError):
        await manager.create_shell_task(
            command=_python_stdout_command("never starts"),
            description="bad cwd",
            cwd=tmp_path / "missing",
        )

    tasks = manager.list_tasks()
    assert len(tasks) == 1
    assert tasks[0].status == "failed"
    assert tasks[0].ended_at is not None
    assert tasks[0].metadata["start_error"]


@pytest.mark.asyncio
async def test_start_failure_notifies_completion_listener(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()
    seen: list[tuple[str, str]] = []

    def _listener(task):
        seen.append((task.description, task.status))

    manager.register_completion_listener(_listener)

    with pytest.raises(OSError):
        await manager.create_shell_task(
            command=_python_stdout_command("never starts"),
            description="bad cwd",
            cwd=tmp_path / "missing",
        )

    assert seen == [("bad cwd", "failed")]


@pytest.mark.asyncio
async def test_completion_listener_fires_when_task_finishes(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()
    seen: list[tuple[str, str, int | None]] = []
    done = asyncio.Event()

    async def _listener(task):
        seen.append((task.id, task.status, task.return_code))
        done.set()

    manager.register_completion_listener(_listener)

    task = await manager.create_shell_task(
        command=_python_stdout_command("done"),
        description="listener",
        cwd=tmp_path,
    )

    await asyncio.wait_for(done.wait(), timeout=5)

    assert seen == [(task.id, "completed", 0)]


@pytest.mark.asyncio
async def test_completion_listener_sees_killed_status_for_stopped_task(
    tmp_path: Path, monkeypatch
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BackgroundTaskManager()
    seen: list[tuple[str, str]] = []
    done = asyncio.Event()

    def _listener(task):
        seen.append((task.id, task.status))
        done.set()

    manager.register_completion_listener(_listener)

    task = await manager.create_shell_task(
        command="sleep 30",
        description="listener stop",
        cwd=tmp_path,
    )

    await manager.stop_task(task.id)
    await asyncio.wait_for(done.wait(), timeout=5)

    assert seen == [(task.id, "killed")]


@pytest.mark.asyncio
async def test_output_capture_failure_marks_task_failed_and_releases_process(tmp_path: Path):
    manager = BackgroundTaskManager()
    output_path = tmp_path / "capture-failure.log"
    output_path.write_text("", encoding="utf-8")
    record = TaskRecord(
        id="capture-failure",
        type="local_bash",
        status="running",
        description="capture failure",
        cwd=str(tmp_path),
        output_file=output_path,
    )

    class _FakeProcess:
        stdin = None

        async def wait(self) -> int:
            return 0

    async def _fail_copy_output(task_id, process) -> None:
        del task_id, process
        raise OSError("disk full")

    process = _FakeProcess()
    manager._tasks[record.id] = record  # type: ignore[attr-defined]
    manager._generations[record.id] = 1  # type: ignore[attr-defined]
    manager._processes[record.id] = process  # type: ignore[attr-defined]
    manager._copy_output = _fail_copy_output  # type: ignore[method-assign]

    await manager._watch_process(record.id, process, 1)  # type: ignore[arg-type,attr-defined]

    assert record.status == "failed"
    assert record.metadata["output_error"] == "disk full"
    assert record.ended_at is not None
    assert record.id not in manager._processes  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_nowait_update_listener_task_is_retained_until_completion(tmp_path: Path):
    manager = BackgroundTaskManager()
    release = asyncio.Event()
    started = asyncio.Event()
    record = TaskRecord(
        id="listener-retention",
        type="local_bash",
        status="running",
        description="listener retention",
        cwd=str(tmp_path),
        output_file=tmp_path / "listener-retention.log",
    )
    manager._tasks[record.id] = record  # type: ignore[attr-defined]

    async def _listener(task: TaskRecord) -> None:
        del task
        started.set()
        await release.wait()

    manager.register_update_listener(_listener)
    manager.notify_task_updated(record.id)
    await asyncio.wait_for(started.wait(), timeout=1)

    assert len(manager._notification_tasks) == 1  # type: ignore[attr-defined]
    release.set()
    await asyncio.gather(*manager._notification_tasks)  # type: ignore[attr-defined]
    await asyncio.sleep(0)
    assert not manager._notification_tasks  # type: ignore[attr-defined]
