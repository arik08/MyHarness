from __future__ import annotations

import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from myharness.api.usage import UsageSnapshot
from myharness.ui.runtime import (
    build_runtime,
    close_runtime,
    schedule_runtime_prefix_cache_warmup,
    start_runtime,
)


class _BlockingPrewarmClient:
    def __init__(self) -> None:
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.request = None

    async def prewarm_prompt_cache(self, request):
        self.request = request
        self.started.set()
        await self.release.wait()
        return UsageSnapshot(input_tokens=100, cached_input_tokens=80)

    async def stream_message(self, request):
        del request
        if False:
            yield None


@pytest.mark.asyncio
async def test_start_runtime_prewarms_prefix_in_background(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    client = _BlockingPrewarmClient()
    bundle = await build_runtime(
        api_client=client,
        cwd=str(tmp_path),
        connect_mcp=False,
    )
    monkeypatch.setattr(bundle.mcp_manager, "list_statuses", lambda: [])

    try:
        await asyncio.wait_for(start_runtime(bundle), timeout=1)
        await asyncio.wait_for(client.started.wait(), timeout=1)

        assert bundle.prefix_cache_warmup_task is not None
        assert not bundle.prefix_cache_warmup_task.done()
        assert client.request is not None
        assert client.request.model == bundle.engine.model
        assert client.request.system_prompt == bundle.engine.system_prompt
        assert client.request.tools == sorted(
            bundle.tool_registry.to_api_schema(),
            key=lambda schema: str(schema.get("name") or ""),
        )

        client.release.set()
        await asyncio.wait_for(bundle.prefix_cache_warmup_task, timeout=1)
    finally:
        await close_runtime(bundle)


@pytest.mark.asyncio
async def test_start_runtime_defers_prewarm_until_pending_mcp_is_resolved(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    client = _BlockingPrewarmClient()
    bundle = await build_runtime(
        api_client=client,
        cwd=str(tmp_path),
        connect_mcp=False,
    )
    statuses = [SimpleNamespace(state="pending")]
    monkeypatch.setattr(bundle.mcp_manager, "list_statuses", lambda: statuses)

    try:
        await start_runtime(bundle)
        await asyncio.sleep(0)
        assert bundle.prefix_cache_warmup_task is None
        assert not client.started.is_set()

        statuses.clear()
        await schedule_runtime_prefix_cache_warmup(bundle)
        await asyncio.wait_for(client.started.wait(), timeout=1)
        assert bundle.prefix_cache_warmup_task is not None

        client.release.set()
        await asyncio.wait_for(bundle.prefix_cache_warmup_task, timeout=1)
    finally:
        await close_runtime(bundle)
