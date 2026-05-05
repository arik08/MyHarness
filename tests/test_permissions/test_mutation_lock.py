from pathlib import Path
import json
import time

import pytest

from myharness.permissions.mutation_lock import (
    LOCK_STALE_SECONDS,
    MutationLockTimeout,
    acquire_mutation_lock,
    lock_is_contended,
    release_mutation_lock,
)


@pytest.mark.asyncio
async def test_mutation_lock_waits_until_released(tmp_path: Path):
    first = await acquire_mutation_lock(tmp_path, owner="first", timeout_seconds=0.2)
    assert lock_is_contended(tmp_path) is True
    release_mutation_lock(first)

    second = await acquire_mutation_lock(tmp_path, owner="second", timeout_seconds=0.2)
    try:
        assert lock_is_contended(tmp_path) is True
    finally:
        release_mutation_lock(second)


@pytest.mark.asyncio
async def test_mutation_lock_times_out_when_held(tmp_path: Path):
    first = await acquire_mutation_lock(tmp_path, owner="first", timeout_seconds=0.2)
    try:
        with pytest.raises(MutationLockTimeout):
            await acquire_mutation_lock(tmp_path, owner="second", timeout_seconds=0.01)
    finally:
        release_mutation_lock(first)


def test_mutation_lock_removes_dead_owner_without_waiting_for_stale_age(
    tmp_path: Path,
    monkeypatch,
):
    lock_path = tmp_path / ".myharness" / "mutation.lock"
    lock_path.parent.mkdir()
    lock_path.write_text(
        json.dumps({"owner": "dead", "pid": 999999, "created_at": time.time()}),
        encoding="utf-8",
    )
    monkeypatch.setattr("myharness.permissions.mutation_lock._process_exists", lambda pid: False)

    assert lock_is_contended(tmp_path) is False
    assert not lock_path.exists()


def test_mutation_lock_keeps_live_owner_until_stale_age(tmp_path: Path, monkeypatch):
    lock_path = tmp_path / ".myharness" / "mutation.lock"
    lock_path.parent.mkdir()
    lock_path.write_text(
        json.dumps({"owner": "live", "pid": 1234, "created_at": time.time()}),
        encoding="utf-8",
    )
    fresh_time = time.time() - (LOCK_STALE_SECONDS / 2)
    import os

    os.utime(lock_path, (fresh_time, fresh_time))
    monkeypatch.setattr("myharness.permissions.mutation_lock._process_exists", lambda pid: True)

    assert lock_is_contended(tmp_path) is True
    assert lock_path.exists()
