"""Project-scoped mutation lock for concurrent web sessions."""

from __future__ import annotations

import asyncio
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
    return root / ".openharness" / "mutation.lock"


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
    if age < LOCK_STALE_SECONDS:
        return False
    try:
        path.unlink()
        return True
    except OSError:
        return False
