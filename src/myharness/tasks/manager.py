"""Background task manager."""

from __future__ import annotations

import asyncio
import logging
import os
import shlex
import sys
import time
import json
from dataclasses import replace
from pathlib import Path
from typing import Awaitable, Callable
from uuid import uuid4

from myharness.config.paths import get_tasks_dir
from myharness.tasks.types import TaskRecord, TaskStatus, TaskType
from myharness.utils.shell import create_shell_subprocess

log = logging.getLogger(__name__)
TASK_PROGRESS_EVENT_PREFIX = "__MYHARNESS_TASK_UPDATE__"

CompletionListener = Callable[[TaskRecord], Awaitable[None] | None]
UpdateListener = Callable[[TaskRecord], Awaitable[None] | None]


class BackgroundTaskManager:
    """Manage shell and agent subprocess tasks."""

    def __init__(self) -> None:
        self._tasks: dict[str, TaskRecord] = {}
        self._processes: dict[str, asyncio.subprocess.Process] = {}
        self._waiters: dict[str, asyncio.Task[None]] = {}
        self._output_locks: dict[str, asyncio.Lock] = {}
        self._input_locks: dict[str, asyncio.Lock] = {}
        self._control_buffers: dict[str, str] = {}
        self._generations: dict[str, int] = {}
        self._completion_listeners: dict[str, CompletionListener] = {}
        self._update_listeners: dict[str, UpdateListener] = {}

    async def create_shell_task(
        self,
        *,
        command: str,
        description: str,
        cwd: str | Path,
        task_type: TaskType = "local_bash",
        env: dict[str, str] | None = None,
    ) -> TaskRecord:
        """Start a background shell command."""
        task_id = _task_id(task_type)
        output_path = get_tasks_dir() / f"{task_id}.log"
        record = TaskRecord(
            id=task_id,
            type=task_type,
            status="running",
            description=description,
            cwd=str(Path(cwd).resolve()),
            output_file=output_path,
            command=command,
            env=dict(env or {}),
            created_at=time.time(),
            started_at=time.time(),
        )
        output_path.write_text("", encoding="utf-8")
        self._tasks[task_id] = record
        self._output_locks[task_id] = asyncio.Lock()
        self._input_locks[task_id] = asyncio.Lock()
        record.env = {
            key: value.replace("{task_id}", task_id).replace("{{TASK_ID}}", task_id)
            for key, value in record.env.items()
        }
        await self._notify_update_listeners(record)
        try:
            await self._start_process(task_id)
        except OSError as exc:
            await self._mark_start_failed(record, exc)
            raise
        return record

    async def create_agent_task(
        self,
        *,
        prompt: str,
        description: str,
        cwd: str | Path,
        task_type: TaskType = "local_agent",
        model: str | None = None,
        api_key: str | None = None,
        command: str | None = None,
        env: dict[str, str] | None = None,
    ) -> TaskRecord:
        """Start a local agent task as a subprocess."""
        if command is None:
            effective_api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
            if not effective_api_key:
                raise ValueError(
                    "Local agent tasks require ANTHROPIC_API_KEY or an explicit command override"
                )
            cmd = [sys.executable, "-m", "myharness", "--api-key", effective_api_key]
            if model:
                cmd.extend(["--model", model])
            command = _shell_command_from_argv(cmd)

        record = await self.create_shell_task(
            command=command,
            description=description,
            cwd=cwd,
            task_type=task_type,
            env=env,
        )
        effective_prompt = prompt.replace("{task_id}", record.id).replace("{{TASK_ID}}", record.id)
        updated = replace(record, prompt=effective_prompt)
        if task_type != "local_agent":
            updated.metadata["agent_mode"] = task_type
        self._tasks[record.id] = updated
        await self.write_to_task(record.id, effective_prompt)
        return updated

    def get_task(self, task_id: str) -> TaskRecord | None:
        """Return one task record."""
        return self._tasks.get(task_id)

    def list_tasks(self, *, status: TaskStatus | None = None) -> list[TaskRecord]:
        """Return all tasks, optionally filtered by status."""
        tasks = list(self._tasks.values())
        if status is not None:
            tasks = [task for task in tasks if task.status == status]
        return sorted(tasks, key=lambda item: item.created_at, reverse=True)

    def update_task(
        self,
        task_id: str,
        *,
        description: str | None = None,
        progress: int | None = None,
        status_note: str | None = None,
    ) -> TaskRecord:
        """Update mutable task metadata used for coordination and UI display."""
        task = self._require_task(task_id)
        if description is not None and description.strip():
            task.description = description.strip()
        if progress is not None:
            task.metadata["progress"] = str(progress)
        if status_note is not None:
            note = status_note.strip()
            if note:
                task.metadata["status_note"] = note
            else:
                task.metadata.pop("status_note", None)
        self._notify_update_listeners_nowait(task)
        return task

    def notify_task_updated(self, task_id: str) -> None:
        """Notify UI/coordinator listeners after external task metadata changes."""
        task = self._require_task(task_id)
        self._notify_update_listeners_nowait(task)

    async def stop_task(self, task_id: str) -> TaskRecord:
        """Terminate a running task."""
        task = self._require_task(task_id)
        process = self._processes.get(task_id)
        if process is None:
            if task.status in {"completed", "failed", "killed"}:
                return task
            raise ValueError(f"Task {task_id} is not running")

        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), timeout=3)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
        await _close_process_stdin(process)

        task.status = "killed"
        task.ended_at = time.time()
        await self._notify_update_listeners(task)
        return task

    async def write_to_task(self, task_id: str, data: str) -> None:
        """Write one line to task stdin, auto-resuming local agents when needed."""
        task = self._require_task(task_id)
        async with self._input_locks[task_id]:
            process = await self._ensure_writable_process(task)
            process.stdin.write((data.rstrip("\n") + "\n").encode("utf-8"))
            try:
                await process.stdin.drain()
            except (BrokenPipeError, ConnectionResetError):
                if task.type not in {"local_agent", "remote_agent", "in_process_teammate"}:
                    raise ValueError(f"Task {task_id} does not accept input") from None
                process = await self._restart_agent_task(task)
                process.stdin.write((data.rstrip("\n") + "\n").encode("utf-8"))
                await process.stdin.drain()

    def read_task_output(self, task_id: str, *, max_bytes: int = 12000) -> str:
        """Return the tail of a task's output file."""
        task = self._require_task(task_id)
        if max_bytes <= 0:
            return ""
        try:
            content = task.output_file.read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            return ""
        if len(content) > max_bytes:
            return content[-max_bytes:]
        return content

    async def _mark_start_failed(self, task: TaskRecord, exc: OSError) -> None:
        task.status = "failed"
        task.ended_at = time.time()
        task.metadata["start_error"] = str(exc)
        task.output_file.write_text(f"Failed to start task: {exc}\n", encoding="utf-8")
        await self._notify_completion_listeners(task)

    def register_completion_listener(self, listener: CompletionListener) -> Callable[[], None]:
        """Register a callback fired whenever a task reaches a terminal state."""
        listener_id = uuid4().hex
        self._completion_listeners[listener_id] = listener

        def _unregister() -> None:
            self._completion_listeners.pop(listener_id, None)

        return _unregister

    def register_update_listener(self, listener: UpdateListener) -> Callable[[], None]:
        """Register a callback fired whenever task status, metadata, or output changes."""
        listener_id = uuid4().hex
        self._update_listeners[listener_id] = listener

        def _unregister() -> None:
            self._update_listeners.pop(listener_id, None)

        return _unregister

    async def _watch_process(
        self,
        task_id: str,
        process: asyncio.subprocess.Process,
        generation: int,
    ) -> None:
        reader = asyncio.create_task(self._copy_output(task_id, process))
        return_code = await process.wait()
        await reader
        await _close_process_stdin(process)

        current_generation = self._generations.get(task_id)
        if current_generation != generation:
            return

        task = self._tasks[task_id]
        task.return_code = return_code
        if task.status != "killed":
            task.status = "completed" if return_code == 0 else "failed"
        task.ended_at = time.time()
        await self._notify_update_listeners(task)
        await self._notify_completion_listeners(task)
        self._processes.pop(task_id, None)
        self._waiters.pop(task_id, None)

    async def _copy_output(self, task_id: str, process: asyncio.subprocess.Process) -> None:
        if process.stdout is None:
            return
        while True:
            chunk = await process.stdout.read(4096)
            if not chunk:
                trailing = self._pop_control_buffer(task_id)
                if trailing:
                    async with self._output_locks[task_id]:
                        with self._tasks[task_id].output_file.open("ab") as handle:
                            handle.write(trailing.encode("utf-8"))
                return
            visible_chunk = self._filter_control_output(task_id, chunk)
            if not visible_chunk:
                continue
            async with self._output_locks[task_id]:
                with self._tasks[task_id].output_file.open("ab") as handle:
                    handle.write(visible_chunk)
            await self._notify_update_listeners(self._tasks[task_id])

    def _filter_control_output(self, task_id: str, chunk: bytes) -> bytes:
        text = self._control_buffers.get(task_id, "") + chunk.decode("utf-8", errors="replace")
        lines = text.splitlines(keepends=True)
        if lines and not lines[-1].endswith(("\n", "\r")):
            self._control_buffers[task_id] = lines.pop()
        else:
            self._control_buffers.pop(task_id, None)

        visible: list[str] = []
        for line in lines:
            stripped = line.rstrip("\r\n")
            if stripped.startswith(TASK_PROGRESS_EVENT_PREFIX):
                self._apply_child_task_update(task_id, stripped[len(TASK_PROGRESS_EVENT_PREFIX):])
            else:
                visible.append(line)
        return "".join(visible).encode("utf-8")

    def _pop_control_buffer(self, task_id: str) -> str:
        trailing = self._control_buffers.pop(task_id, "")
        if trailing.startswith(TASK_PROGRESS_EVENT_PREFIX):
            self._apply_child_task_update(task_id, trailing[len(TASK_PROGRESS_EVENT_PREFIX):])
            return ""
        return trailing

    def _apply_child_task_update(self, task_id: str, payload: str) -> None:
        task = self._tasks.get(task_id)
        if task is None:
            return
        try:
            data = json.loads(payload)
        except json.JSONDecodeError:
            return
        if str(data.get("task_id") or "") != task_id:
            return
        description = str(data.get("description") or "").strip()
        if description:
            task.description = description
        progress = data.get("progress")
        if progress is not None:
            task.metadata["progress"] = str(progress)
        status_note = str(data.get("status_note") or "").strip()
        if status_note:
            task.metadata["status_note"] = status_note
        elif "status_note" in data:
            task.metadata.pop("status_note", None)
        self._notify_update_listeners_nowait(task)

    def _require_task(self, task_id: str) -> TaskRecord:
        task = self._tasks.get(task_id)
        if task is None:
            raise ValueError(f"No task found with ID: {task_id}")
        return task

    async def _start_process(self, task_id: str) -> asyncio.subprocess.Process:
        task = self._require_task(task_id)
        if task.command is None:
            raise ValueError(f"Task {task_id} does not have a command to run")

        generation = self._generations.get(task_id, 0) + 1
        self._generations[task_id] = generation
        process = await create_shell_subprocess(
            task.command,
            cwd=task.cwd,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            env={**os.environ, **task.env} if task.env else None,
        )
        self._processes[task_id] = process
        self._waiters[task_id] = asyncio.create_task(
            self._watch_process(task_id, process, generation)
        )
        return process

    async def _ensure_writable_process(
        self,
        task: TaskRecord,
    ) -> asyncio.subprocess.Process:
        process = self._processes.get(task.id)
        if process is not None and process.stdin is not None and process.returncode is None:
            return process
        if task.type not in {"local_agent", "remote_agent", "in_process_teammate"}:
            raise ValueError(f"Task {task.id} does not accept input")
        return await self._restart_agent_task(task)

    async def _restart_agent_task(self, task: TaskRecord) -> asyncio.subprocess.Process:
        if task.command is None:
            raise ValueError(f"Task {task.id} does not have a restart command")

        waiter = self._waiters.get(task.id)
        if waiter is not None and not waiter.done():
            await waiter

        restart_count = int(task.metadata.get("restart_count", "0")) + 1
        task.metadata["restart_count"] = str(restart_count)
        task.status = "running"
        task.started_at = time.time()
        task.ended_at = None
        task.return_code = None
        await self._notify_update_listeners(task)
        return await self._start_process(task.id)

    async def _notify_completion_listeners(self, task: TaskRecord) -> None:
        snapshot = replace(task, metadata=dict(task.metadata))
        for listener_id, listener in list(self._completion_listeners.items()):
            try:
                maybe_awaitable = listener(snapshot)
                if maybe_awaitable is not None:
                    await maybe_awaitable
            except Exception:
                log.exception("Task completion listener %s failed for task %s", listener_id, task.id)

    async def _notify_update_listeners(self, task: TaskRecord) -> None:
        snapshot = replace(task, metadata=dict(task.metadata))
        for listener_id, listener in list(self._update_listeners.items()):
            try:
                maybe_awaitable = listener(snapshot)
                if maybe_awaitable is not None:
                    await maybe_awaitable
            except Exception:
                log.exception("Task update listener %s failed for task %s", listener_id, task.id)

    def _notify_update_listeners_nowait(self, task: TaskRecord) -> None:
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        loop.create_task(self._notify_update_listeners(task))

    def close(self) -> None:
        """Best-effort cleanup for any tracked subprocesses and watcher tasks."""
        for waiter in list(self._waiters.values()):
            waiter.cancel()
        self._waiters.clear()

        for process in list(self._processes.values()):
            stdin = process.stdin
            if stdin is not None and not stdin.is_closing():
                try:
                    stdin.close()
                except RuntimeError:
                    pass
            if process.returncode is None:
                try:
                    process.kill()
                except (ProcessLookupError, RuntimeError):
                    pass
        self._processes.clear()

    async def aclose(self) -> None:
        """Asynchronously shut down tracked subprocesses and waiters."""
        processes = list(self._processes.values())
        waiters = list(self._waiters.values())

        for process in processes:
            if process.returncode is None:
                try:
                    process.kill()
                except ProcessLookupError:
                    pass
            await _close_process_stdin(process)

        for process in processes:
            if process.returncode is None:
                try:
                    await process.wait()
                except ProcessLookupError:
                    pass

        if waiters:
            await asyncio.gather(*waiters, return_exceptions=True)

        self._processes.clear()
        self._waiters.clear()


_DEFAULT_MANAGER: BackgroundTaskManager | None = None
_DEFAULT_MANAGER_KEY: str | None = None


def get_task_manager() -> BackgroundTaskManager:
    """Return the singleton task manager."""
    global _DEFAULT_MANAGER, _DEFAULT_MANAGER_KEY
    current_key = str(get_tasks_dir().resolve())
    if _DEFAULT_MANAGER is None or _DEFAULT_MANAGER_KEY != current_key:
        if _DEFAULT_MANAGER is not None:
            _DEFAULT_MANAGER.close()
        _DEFAULT_MANAGER = BackgroundTaskManager()
        _DEFAULT_MANAGER_KEY = current_key
    return _DEFAULT_MANAGER


def reset_task_manager() -> None:
    """Reset the singleton task manager, closing tracked subprocesses first."""
    global _DEFAULT_MANAGER, _DEFAULT_MANAGER_KEY
    if _DEFAULT_MANAGER is not None:
        _DEFAULT_MANAGER.close()
    _DEFAULT_MANAGER = None
    _DEFAULT_MANAGER_KEY = None


async def shutdown_task_manager() -> None:
    """Async reset that fully reaps tracked subprocesses before clearing state."""
    global _DEFAULT_MANAGER, _DEFAULT_MANAGER_KEY
    if _DEFAULT_MANAGER is not None:
        await _DEFAULT_MANAGER.aclose()
    _DEFAULT_MANAGER = None
    _DEFAULT_MANAGER_KEY = None


def _task_id(task_type: TaskType) -> str:
    prefixes = {
        "local_bash": "b",
        "local_agent": "a",
        "remote_agent": "r",
        "in_process_teammate": "t",
    }
    return f"{prefixes[task_type]}{uuid4().hex[:8]}"


def _shell_command_from_argv(argv: list[str]) -> str:
    if sys.platform == "win32":
        return "& " + " ".join(_quote_powershell_arg(part) for part in argv)
    return " ".join(shlex.quote(part) for part in argv)


def _quote_powershell_arg(value: str) -> str:
    return "'" + value.replace("'", "''") + "'"


async def _close_process_stdin(process: asyncio.subprocess.Process) -> None:
    stdin = process.stdin
    if stdin is None or stdin.is_closing():
        return
    stdin.close()
    try:
        await stdin.wait_closed()
    except (BrokenPipeError, ConnectionResetError):
        pass
