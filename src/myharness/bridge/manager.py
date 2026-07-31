"""Track spawned bridge sessions for UI and commands."""

from __future__ import annotations

import asyncio
import os
from dataclasses import dataclass
from pathlib import Path

from myharness.config.paths import get_data_dir
from myharness.bridge.session_runner import SessionHandle, spawn_session


BRIDGE_OUTPUT_READ_CHUNK_BYTES = 64 * 1024
BRIDGE_OUTPUT_MAX_BYTES = 16 * 1024 * 1024


@dataclass(frozen=True)
class BridgeSessionRecord:
    """UI-safe bridge session snapshot."""

    session_id: str
    command: str
    cwd: str
    pid: int
    status: str
    started_at: float
    output_path: str


class BridgeSessionManager:
    """Manage bridge-run child sessions and capture their output."""

    def __init__(self) -> None:
        self._sessions: dict[str, SessionHandle] = {}
        self._commands: dict[str, str] = {}
        self._output_paths: dict[str, Path] = {}
        self._copy_tasks: dict[str, asyncio.Task[None]] = {}

    async def spawn(self, *, session_id: str, command: str, cwd: str | Path) -> SessionHandle:
        handle = await spawn_session(session_id=session_id, command=command, cwd=cwd)
        self._sessions[session_id] = handle
        self._commands[session_id] = command
        output_dir = get_data_dir() / "bridge"
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / f"{session_id}.log"
        output_path.write_text("", encoding="utf-8")
        self._output_paths[session_id] = output_path
        self._copy_tasks[session_id] = asyncio.create_task(self._copy_output(session_id, handle))
        return handle

    def list_sessions(self) -> list[BridgeSessionRecord]:
        items: list[BridgeSessionRecord] = []
        for session_id, handle in self._sessions.items():
            process = handle.process
            if process.returncode is None:
                status = "running"
            elif process.returncode == 0:
                status = "completed"
            else:
                status = "failed"
            items.append(
                BridgeSessionRecord(
                    session_id=session_id,
                    command=self._commands.get(session_id, ""),
                    cwd=str(handle.cwd),
                    pid=process.pid or 0,
                    status=status,
                    started_at=handle.started_at,
                    output_path=str(self._output_paths[session_id]),
                )
            )
        return sorted(items, key=lambda item: item.started_at, reverse=True)

    def read_output(self, session_id: str, *, max_bytes: int = 12000) -> str:
        path = self._output_paths.get(session_id)
        if path is None or max_bytes <= 0:
            return ""
        current = _read_file_tail(path, max_bytes)
        remaining = max_bytes - len(current)
        if remaining > 0:
            current = _read_file_tail(_backup_path(path), remaining) + current
        return current.decode("utf-8", errors="replace")

    async def stop(self, session_id: str) -> None:
        handle = self._sessions.get(session_id)
        if handle is None:
            raise ValueError(f"Unknown bridge session: {session_id}")
        await handle.kill()

    async def _copy_output(self, session_id: str, handle: SessionHandle) -> None:
        path = self._output_paths[session_id]
        try:
            if handle.process.stdout is not None:
                while True:
                    chunk = await handle.process.stdout.read(BRIDGE_OUTPUT_READ_CHUNK_BYTES)
                    if not chunk:
                        break
                    await asyncio.to_thread(_append_output, path, chunk)
            await handle.process.wait()
        finally:
            self._copy_tasks.pop(session_id, None)


def _append_output(path: Path, chunk: bytes) -> None:
    if not chunk:
        return
    backup = _backup_path(path)
    try:
        current_size = path.stat().st_size
    except FileNotFoundError:
        current_size = 0
    if current_size + len(chunk) > BRIDGE_OUTPUT_MAX_BYTES:
        backup.unlink(missing_ok=True)
        if path.exists():
            path.replace(backup)
            _trim_file_tail(backup, BRIDGE_OUTPUT_MAX_BYTES)
        if len(chunk) > BRIDGE_OUTPUT_MAX_BYTES:
            chunk = chunk[-BRIDGE_OUTPUT_MAX_BYTES:]
    with path.open("ab") as stream:
        stream.write(chunk)


def _backup_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.1")


def _read_file_tail(path: Path, max_bytes: int) -> bytes:
    try:
        with path.open("rb") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            handle.seek(max(0, size - max_bytes))
            return handle.read(max_bytes)
    except FileNotFoundError:
        return b""


def _trim_file_tail(path: Path, max_bytes: int) -> None:
    try:
        with path.open("r+b") as handle:
            handle.seek(0, os.SEEK_END)
            size = handle.tell()
            if size <= max_bytes:
                return
            handle.seek(size - max_bytes)
            tail = handle.read(max_bytes)
            handle.seek(0)
            handle.write(tail)
            handle.truncate()
    except FileNotFoundError:
        return


_DEFAULT_MANAGER: BridgeSessionManager | None = None


def get_bridge_manager() -> BridgeSessionManager:
    """Return the singleton bridge manager."""
    global _DEFAULT_MANAGER
    if _DEFAULT_MANAGER is None:
        _DEFAULT_MANAGER = BridgeSessionManager()
    return _DEFAULT_MANAGER

