"""Tests for bounded outbound HTTP response handling."""

from __future__ import annotations

import httpx
import pytest

from myharness.utils.network_guard import NetworkGuardError, _read_bounded_response_body


class _ChunkStream(httpx.AsyncByteStream):
    def __init__(self, chunks: list[bytes]) -> None:
        self._chunks = chunks

    async def __aiter__(self):
        for chunk in self._chunks:
            yield chunk


@pytest.mark.asyncio
async def test_bounded_response_rejects_declared_oversize() -> None:
    response = httpx.Response(200, content=b"small")
    response.headers["content-length"] = "11"

    with pytest.raises(NetworkGuardError, match="exceeds 10 bytes"):
        await _read_bounded_response_body(response, 10)


@pytest.mark.asyncio
async def test_bounded_response_rejects_streamed_oversize() -> None:
    response = httpx.Response(200, stream=_ChunkStream([b"12345", b"678901"]))

    with pytest.raises(NetworkGuardError, match="exceeds 10 bytes"):
        await _read_bounded_response_body(response, 10)
