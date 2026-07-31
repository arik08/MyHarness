"""Bounded asyncio subprocess pipe collection."""

from __future__ import annotations

import asyncio
import contextlib

DEFAULT_READ_CHUNK_BYTES = 64 * 1024
DEFAULT_TAIL_BYTES = 64 * 1024


async def communicate_bounded(
    process: asyncio.subprocess.Process,
    *,
    timeout: float,
    tail_bytes: int = DEFAULT_TAIL_BYTES,
    read_chunk_bytes: int = DEFAULT_READ_CHUNK_BYTES,
) -> tuple[bytes, bytes]:
    """Drain stdout and stderr concurrently while retaining only their latest bytes."""
    readers = (
        asyncio.create_task(
            _read_stream_tail(
                process.stdout,
                tail_bytes=tail_bytes,
                read_chunk_bytes=read_chunk_bytes,
            )
        ),
        asyncio.create_task(
            _read_stream_tail(
                process.stderr,
                tail_bytes=tail_bytes,
                read_chunk_bytes=read_chunk_bytes,
            )
        ),
    )
    try:
        await asyncio.wait_for(process.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(ProcessLookupError):
            await process.wait()
        await asyncio.gather(*readers, return_exceptions=True)
        raise
    except BaseException:
        with contextlib.suppress(ProcessLookupError):
            process.kill()
        with contextlib.suppress(ProcessLookupError):
            await process.wait()
        for reader in readers:
            reader.cancel()
        await asyncio.gather(*readers, return_exceptions=True)
        raise
    stdout, stderr = await asyncio.gather(*readers)
    return stdout, stderr


async def _read_stream_tail(
    stream: asyncio.StreamReader | None,
    *,
    tail_bytes: int,
    read_chunk_bytes: int,
) -> bytes:
    if stream is None or tail_bytes <= 0:
        return b""
    tail = b""
    while True:
        chunk = await stream.read(read_chunk_bytes)
        if not chunk:
            return tail
        if len(chunk) >= tail_bytes:
            tail = chunk[-tail_bytes:]
        else:
            tail = (tail + chunk)[-tail_bytes:]
