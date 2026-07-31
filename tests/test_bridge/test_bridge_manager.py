"""Tests for bounded bridge session output management."""

from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace
import shlex
import sys

import pytest

import myharness.bridge.manager as bridge_manager_module
from myharness.bridge.manager import BridgeSessionManager


def _stderr_command(text: str) -> str:
    code = f"import sys; sys.stderr.write({text!r})"
    if sys.platform == "win32":
        executable = str(Path(sys.executable)).replace("'", "''")
        escaped = code.replace("'", "''")
        return f"& '{executable}' -c '{escaped}'"
    return f"{shlex.quote(sys.executable)} -c {shlex.quote(code)}"


def test_read_output_joins_rotated_tail(tmp_path: Path) -> None:
    manager = BridgeSessionManager()
    path = tmp_path / "bridge.log"
    backup = path.with_name(f"{path.name}.1")
    backup.write_bytes(b"A" * 40)
    path.write_bytes(b"B" * 40)
    manager._output_paths["session"] = path  # type: ignore[attr-defined]

    assert manager.read_output("session", max_bytes=64) == "A" * 24 + "B" * 40
    assert manager.read_output("session", max_bytes=0) == ""


@pytest.mark.asyncio
async def test_copy_output_is_bounded_and_releases_copy_task(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Reader:
        def __init__(self) -> None:
            self.chunks = [b"A" * 40, b"B" * 40, b"C" * 40]

        async def read(self, size: int) -> bytes:
            del size
            return self.chunks.pop(0) if self.chunks else b""

    class _Process:
        stdout = _Reader()

        async def wait(self) -> int:
            return 0

    monkeypatch.setattr(bridge_manager_module, "BRIDGE_OUTPUT_MAX_BYTES", 64)
    manager = BridgeSessionManager()
    path = tmp_path / "bridge.log"
    path.write_bytes(b"")
    manager._output_paths["session"] = path  # type: ignore[attr-defined]
    manager._copy_tasks["session"] = asyncio.current_task()  # type: ignore[attr-defined]
    handle = SimpleNamespace(process=_Process())

    await manager._copy_output("session", handle)  # type: ignore[arg-type, attr-defined]

    backup = path.with_name(f"{path.name}.1")
    assert path.stat().st_size <= 64
    assert backup.stat().st_size <= 64
    assert manager.read_output("session", max_bytes=64) == "B" * 24 + "C" * 40
    assert "session" not in manager._copy_tasks  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_spawn_captures_stderr_in_bridge_output(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    manager = BridgeSessionManager()

    handle = await manager.spawn(
        session_id="stderr-session",
        command=_stderr_command("bridge error"),
        cwd=tmp_path,
    )
    await handle.process.wait()
    copy_task = manager._copy_tasks.get("stderr-session")  # type: ignore[attr-defined]
    if copy_task is not None:
        await copy_task

    assert "bridge error" in manager.read_output("stderr-session")
