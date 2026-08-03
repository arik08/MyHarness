"""Tests for bounded asyncio subprocess output collection."""

from __future__ import annotations

import asyncio

import pytest

from myharness.utils.subprocess_output import communicate_bounded


class _Reader:
    def __init__(self, chunks: list[bytes]) -> None:
        self.chunks = list(chunks)
        self.bytes_read = 0

    async def read(self, size: int) -> bytes:
        del size
        chunk = self.chunks.pop(0) if self.chunks else b""
        self.bytes_read += len(chunk)
        return chunk


class _Process:
    def __init__(self) -> None:
        self.stdout = _Reader([b"A" * 40, b"B" * 40, b"C" * 40])
        self.stderr = _Reader([b"D" * 50, b"E" * 50])

    async def wait(self) -> int:
        return 0


class _Writer:
    def __init__(self) -> None:
        self.data = b""
        self.closed = False

    def write(self, data: bytes) -> None:
        self.data += data

    async def drain(self) -> None:
        return None

    def close(self) -> None:
        self.closed = True


async def test_communicate_bounded_drains_both_streams_and_keeps_tails() -> None:
    process = _Process()

    stdout, stderr = await communicate_bounded(process, timeout=1, tail_bytes=64)

    assert process.stdout.bytes_read == 120
    assert process.stderr.bytes_read == 100
    assert stdout == b"B" * 24 + b"C" * 40
    assert stderr == b"D" * 14 + b"E" * 50


async def test_communicate_bounded_writes_and_closes_stdin() -> None:
    process = _Process()
    process.stdin = _Writer()

    await communicate_bounded(process, timeout=1, input=b"payload")

    assert process.stdin.data == b"payload"
    assert process.stdin.closed is True


async def test_communicate_bounded_kills_process_when_cancelled() -> None:
    class _BlockingReader:
        async def read(self, size: int) -> bytes:
            del size
            await asyncio.Event().wait()
            return b""

    class _BlockingProcess:
        def __init__(self) -> None:
            self.stdout = _BlockingReader()
            self.stderr = _BlockingReader()
            self.stopped = asyncio.Event()
            self.killed = False

        async def wait(self) -> int:
            await self.stopped.wait()
            return 0

        def kill(self) -> None:
            self.killed = True
            self.stopped.set()

    process = _BlockingProcess()
    task = asyncio.create_task(communicate_bounded(process, timeout=60))
    await asyncio.sleep(0)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    assert process.killed is True


async def test_communicate_bounded_times_out_when_inherited_pipe_stays_open() -> None:
    class _BlockingReader:
        async def read(self, size: int) -> bytes:
            del size
            await asyncio.Event().wait()
            return b""

    class _ExitedProcess:
        def __init__(self) -> None:
            self.stdout = _BlockingReader()
            self.stderr = _BlockingReader()
            self.killed = False

        async def wait(self) -> int:
            return 0

        def kill(self) -> None:
            self.killed = True

    process = _ExitedProcess()

    with pytest.raises(asyncio.TimeoutError):
        await asyncio.wait_for(
            communicate_bounded(process, timeout=0.01),
            timeout=0.2,
        )

    assert process.killed is True
