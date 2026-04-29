from pathlib import Path

import pytest

from myharness.permissions.mutation_lock import (
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
