"""Tests for the cron scheduler daemon."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

import pytest

import myharness.services.cron_scheduler as cron_scheduler_module
from myharness.services.cron_scheduler import (
    _jobs_due,
    append_history,
    execute_job,
    get_history_path,
    load_history,
    run_scheduler_loop,
    start_daemon,
    stop_scheduler,
)
from myharness.utils.subprocess_output import _read_stream_tail


@pytest.fixture(autouse=True)
def _tmp_dirs(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Redirect data and log directories to temp."""
    data_dir = tmp_path / "data"
    logs_dir = tmp_path / "logs"
    data_dir.mkdir()
    logs_dir.mkdir()
    monkeypatch.setattr("myharness.services.cron_scheduler.get_data_dir", lambda: data_dir)
    monkeypatch.setattr("myharness.services.cron_scheduler.get_logs_dir", lambda: logs_dir)
    # Also redirect the cron registry used by the scheduler
    monkeypatch.setattr(
        "myharness.services.cron.get_cron_registry_path",
        lambda: data_dir / "cron_jobs.json",
    )


class TestHistory:
    def test_empty_history(self) -> None:
        assert load_history() == []

    def test_append_and_load(self) -> None:
        append_history({"name": "j1", "status": "success"})
        append_history({"name": "j2", "status": "failed"})
        entries = load_history()
        assert len(entries) == 2
        assert entries[0]["name"] == "j1"

    def test_filter_by_name(self) -> None:
        append_history({"name": "j1", "status": "success"})
        append_history({"name": "j2", "status": "success"})
        entries = load_history(job_name="j1")
        assert len(entries) == 1
        assert entries[0]["name"] == "j1"

    def test_limit(self) -> None:
        for i in range(10):
            append_history({"name": f"j{i}", "status": "success"})
        entries = load_history(limit=3)
        assert len(entries) == 3
        # Should be the last 3
        assert entries[0]["name"] == "j7"

    def test_zero_limit_returns_no_history(self) -> None:
        append_history({"name": "j1", "status": "success"})

        assert load_history(limit=0) == []

    def test_non_object_json_lines_are_skipped(self) -> None:
        path = get_history_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            "\n".join(
                [
                    '"not-an-entry"',
                    '["also", "not", "an", "entry"]',
                    '{"name": "j1", "status": "success"}',
                ]
            )
            + "\n",
            encoding="utf-8",
        )

        assert load_history() == [{"name": "j1", "status": "success"}]

    def test_history_rotation_bounds_files_and_preserves_latest_entries(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(cron_scheduler_module, "CRON_HISTORY_MAX_BYTES", 200)

        for i in range(30):
            append_history({"name": f"j{i % 2}", "status": "success", "seq": i})

        path = get_history_path()
        backup = path.with_name(f"{path.name}.1")
        assert path.stat().st_size <= 200
        assert backup.stat().st_size <= 200
        assert [entry["seq"] for entry in load_history(limit=3)] == [27, 28, 29]
        assert [entry["seq"] for entry in load_history(limit=2, job_name="j0")] == [26, 28]


class TestJobsDue:
    def test_due_job(self) -> None:
        now = datetime.now(timezone.utc)
        past = (now - timedelta(minutes=5)).isoformat()
        jobs = [
            {"name": "j1", "schedule": "* * * * *", "enabled": True, "next_run": past},
        ]
        due = _jobs_due(jobs, now)
        assert len(due) == 1

    def test_future_job_not_due(self) -> None:
        now = datetime.now(timezone.utc)
        future = (now + timedelta(hours=1)).isoformat()
        jobs = [
            {"name": "j1", "schedule": "* * * * *", "enabled": True, "next_run": future},
        ]
        due = _jobs_due(jobs, now)
        assert len(due) == 0

    def test_disabled_job_not_due(self) -> None:
        now = datetime.now(timezone.utc)
        past = (now - timedelta(minutes=5)).isoformat()
        jobs = [
            {"name": "j1", "schedule": "* * * * *", "enabled": False, "next_run": past},
        ]
        due = _jobs_due(jobs, now)
        assert len(due) == 0

    def test_invalid_schedule_skipped(self) -> None:
        now = datetime.now(timezone.utc)
        past = (now - timedelta(minutes=5)).isoformat()
        jobs = [
            {"name": "j1", "schedule": "not valid", "enabled": True, "next_run": past},
        ]
        due = _jobs_due(jobs, now)
        assert len(due) == 0

    def test_missing_next_run_skipped(self) -> None:
        now = datetime.now(timezone.utc)
        jobs = [
            {"name": "j1", "schedule": "* * * * *", "enabled": True},
        ]
        due = _jobs_due(jobs, now)
        assert len(due) == 0


class TestExecuteJob:
    @pytest.mark.asyncio
    async def test_stream_tail_reader_drains_all_output_with_bounded_result(self) -> None:
        payload = b"a" * 10_000 + b"b" * 10_000 + b"c" * 10_000

        class _Reader:
            def __init__(self) -> None:
                self.offset = 0

            async def read(self, size: int) -> bytes:
                chunk = payload[self.offset:self.offset + size]
                self.offset += len(chunk)
                return chunk

        reader = _Reader()
        result = await _read_stream_tail(
            reader,
            tail_bytes=cron_scheduler_module.CRON_OUTPUT_TAIL_BYTES,
            read_chunk_bytes=cron_scheduler_module.CRON_OUTPUT_READ_CHUNK_BYTES,
        )

        assert reader.offset == len(payload)
        assert result == payload[-cron_scheduler_module.CRON_OUTPUT_TAIL_BYTES:]

    @pytest.mark.asyncio
    async def test_successful_job(self) -> None:
        job = {"name": "echo-test", "command": "echo hello", "cwd": "/tmp"}
        entry = await execute_job(job)
        assert entry["status"] == "success"
        assert entry["returncode"] == 0
        assert "hello" in entry["stdout"]

    @pytest.mark.asyncio
    async def test_failing_job(self) -> None:
        job = {"name": "fail-test", "command": "exit 1", "cwd": "/tmp"}
        entry = await execute_job(job)
        assert entry["status"] == "failed"
        assert entry["returncode"] == 1

    @pytest.mark.asyncio
    async def test_timeout_job(self) -> None:
        with patch("myharness.services.cron_scheduler.asyncio.wait_for") as mock_wait:
            import asyncio

            async def _raise_timeout(awaitable, *, timeout):
                del timeout
                awaitable.close()
                raise asyncio.TimeoutError()

            mock_wait.side_effect = _raise_timeout

            # Need to mock create_subprocess_exec to return a mock process
            mock_process = AsyncMock()
            mock_process.stdout = None
            mock_process.stderr = None
            mock_process.kill = Mock()
            mock_process.wait = AsyncMock()
            with patch(
                "myharness.utils.shell.asyncio.create_subprocess_exec",
                return_value=mock_process,
            ):
                job = {"name": "slow-test", "command": "sleep 999", "cwd": "/tmp"}
                entry = await execute_job(job)
                assert entry["status"] == "timeout"


class TestSchedulerLoop:
    @pytest.mark.asyncio
    async def test_due_jobs_use_bounded_concurrency(self, monkeypatch: pytest.MonkeyPatch) -> None:
        active = 0
        max_active = 0

        async def _execute(job: dict[str, object]) -> dict[str, object]:
            nonlocal active, max_active
            active += 1
            max_active = max(max_active, active)
            await cron_scheduler_module.asyncio.sleep(0.01)
            active -= 1
            return job

        monkeypatch.setattr(cron_scheduler_module, "execute_job", _execute)
        jobs = [{"name": f"j{i}"} for i in range(12)]

        results = await cron_scheduler_module._execute_due_jobs(jobs)

        assert len(results) == 12
        assert max_active == cron_scheduler_module.CRON_MAX_CONCURRENT_JOBS

    @pytest.mark.asyncio
    async def test_once_mode_with_no_jobs(self) -> None:
        """Scheduler loop in once-mode should complete without error when no jobs exist."""
        await run_scheduler_loop(once=True)

    @pytest.mark.asyncio
    async def test_once_mode_fires_due_job(self) -> None:
        """Scheduler loop should fire a job that is due."""
        from myharness.services.cron import upsert_cron_job

        upsert_cron_job({"name": "test-once", "schedule": "* * * * *", "command": "echo fired"})

        # Force next_run to the past so it's immediately due
        from myharness.services.cron import load_cron_jobs, save_cron_jobs

        jobs = load_cron_jobs()
        now = datetime.now(timezone.utc)
        jobs[0]["next_run"] = (now - timedelta(minutes=1)).isoformat()
        save_cron_jobs(jobs)

        await run_scheduler_loop(once=True)

        entries = load_history(job_name="test-once")
        assert len(entries) == 1
        assert entries[0]["status"] == "success"


class TestSchedulerDaemon:
    def test_daemon_uses_bounded_rotating_log(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        handler_args: dict[str, object] = {}
        basic_config: dict[str, object] = {}

        class _Handler:
            def __init__(self, path, **kwargs) -> None:
                handler_args["path"] = path
                handler_args.update(kwargs)

        def _run(coroutine) -> None:
            coroutine.close()

        monkeypatch.setattr(cron_scheduler_module, "RotatingFileHandler", _Handler)
        monkeypatch.setattr(cron_scheduler_module.logging, "basicConfig", basic_config.update)
        monkeypatch.setattr(cron_scheduler_module.asyncio, "run", _run)

        cron_scheduler_module._run_daemon()

        assert handler_args["path"] == cron_scheduler_module.get_logs_dir() / "cron_scheduler.log"
        assert handler_args["maxBytes"] == cron_scheduler_module.CRON_LOG_MAX_BYTES
        assert handler_args["backupCount"] == cron_scheduler_module.CRON_LOG_BACKUP_COUNT
        assert basic_config["force"] is True

    def test_start_daemon_uses_subprocess_when_fork_is_unavailable(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import os
        import subprocess

        from myharness.services import cron_scheduler

        monkeypatch.delattr(os, "fork", raising=False)
        process = Mock(pid=4321)
        popen = Mock(return_value=process)
        monkeypatch.setattr(subprocess, "Popen", popen)

        assert start_daemon() == 4321
        args, kwargs = popen.call_args
        assert args[0][1] == "-c"
        assert args[0][2] == (
            "from myharness.services.cron_scheduler import _run_daemon; _run_daemon()"
        )
        assert kwargs["stdin"] is subprocess.DEVNULL
        assert kwargs["stdout"] is subprocess.DEVNULL
        assert kwargs["stderr"] is subprocess.DEVNULL
        assert str(Path(cron_scheduler.__file__).resolve().parents[2]) in kwargs["env"][
            "PYTHONPATH"
        ].split(os.pathsep)

    def test_stop_scheduler_without_sigkill_uses_platform_fallback(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        import os
        import signal

        from myharness.services import cron_scheduler

        pid_path = cron_scheduler.get_pid_path()
        pid_path.write_text("4321\n", encoding="utf-8")
        monkeypatch.delattr(signal, "SIGKILL", raising=False)
        monkeypatch.setattr(cron_scheduler.time, "sleep", lambda _: None)
        kill_calls: list[tuple[int, int]] = []

        def fake_kill(pid: int, sig: int) -> None:
            kill_calls.append((pid, sig))

        run = Mock()
        monkeypatch.setattr(os, "kill", fake_kill)
        monkeypatch.setattr(cron_scheduler.subprocess, "run", run)

        assert stop_scheduler() is True
        assert (4321, signal.SIGTERM) in kill_calls
        run.assert_called_once()
        assert not pid_path.exists()
