"""Project-scoped mutation lock for concurrent web sessions."""

from __future__ import annotations

import asyncio
import ctypes
import ctypes.wintypes
import json
import os
import time
from dataclasses import dataclass
from pathlib import Path


LOCK_TIMEOUT_SECONDS = 300
LOCK_POLL_SECONDS = 0.5
LOCK_STALE_SECONDS = 600


@dataclass
class MutationLockToken:
    """An acquired project mutation lock."""

    path: Path
    fd: int
    owner: str


class MutationLockTimeout(TimeoutError):
    """Raised when the project mutation lock could not be acquired in time."""


def mutation_lock_path(cwd: str | Path) -> Path:
    root = Path(cwd).expanduser().resolve()
    return root / ".myharness" / "mutation.lock"


def lock_is_contended(cwd: str | Path) -> bool:
    path = mutation_lock_path(cwd)
    return path.exists() and not _remove_stale_lock(path)


async def acquire_mutation_lock(
    cwd: str | Path,
    *,
    owner: str,
    timeout_seconds: float = LOCK_TIMEOUT_SECONDS,
) -> MutationLockToken:
    """Wait for and acquire the mutation lock for one project."""

    path = mutation_lock_path(cwd)
    path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + timeout_seconds
    payload = {
        "owner": owner,
        "pid": os.getpid(),
        "created_at": time.time(),
    }
    while True:
        _remove_stale_lock(path)
        try:
            fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise MutationLockTimeout(
                    f"Timed out waiting for project mutation lock after {int(timeout_seconds)} seconds."
                )
            await asyncio.sleep(LOCK_POLL_SECONDS)
            continue
        os.write(fd, json.dumps(payload, ensure_ascii=False).encode("utf-8"))
        return MutationLockToken(path=path, fd=fd, owner=owner)


def release_mutation_lock(token: MutationLockToken | None) -> None:
    if token is None:
        return
    try:
        os.close(token.fd)
    except OSError:
        pass
    try:
        token.path.unlink()
    except FileNotFoundError:
        pass
    except OSError:
        pass


def _remove_stale_lock(path: Path) -> bool:
    try:
        age = time.time() - path.stat().st_mtime
    except FileNotFoundError:
        return False
    if _lock_owner_is_dead(path):
        try:
            path.unlink()
            return True
        except OSError:
            return False
    if age < LOCK_STALE_SECONDS:
        return False
    try:
        path.unlink()
        return True
    except OSError:
        return False


def _lock_owner_is_dead(path: Path) -> bool:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return False
    try:
        pid = int(data.get("pid", 0))
    except (TypeError, ValueError):
        return False
    if pid <= 0:
        return False
    return not _process_exists(pid)


def _process_exists(pid: int) -> bool:
    if pid == os.getpid():
        return True
    if os.name == "nt":
        return _windows_process_exists(pid)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    except OSError:
        return True
    return True


def _windows_process_exists(pid: int) -> bool:
    process_query_limited_information = 0x1000
    still_active = 259
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    handle = kernel32.OpenProcess(process_query_limited_information, False, pid)
    if not handle:
        return ctypes.get_last_error() == 5
    try:
        exit_code = ctypes.wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)):
            return True
        return exit_code.value == still_active
    finally:
        kernel32.CloseHandle(handle)
