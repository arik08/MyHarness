"""Provider setup failures must not leave a live API producer behind."""

import asyncio
from types import SimpleNamespace

import pytest

from myharness.api.client import ApiTextDeltaEvent
from myharness.engine.query import _stream_provider_events_with_idle_status


@pytest.mark.parametrize("setting", [
    "MYHARNESS_PROVIDER_STREAM_IDLE_MAX_SECONDS",
    "MYHARNESS_PROVIDER_STREAM_POST_EVENT_IDLE_MAX_SECONDS",
])
async def test_invalid_idle_setting_does_not_start_provider(monkeypatch, setting):
    started = False
    created = []
    create_task = asyncio.create_task

    class Client:
        async def stream_message(self, request):
            nonlocal started
            started = True
            await asyncio.Event().wait()
            yield ApiTextDeltaEvent(text="unexpected")

    def track_task(coro):
        task = create_task(coro)
        created.append(task)
        return task

    monkeypatch.setenv(setting, "invalid")
    monkeypatch.setattr(asyncio, "create_task", track_task)
    stream = _stream_provider_events_with_idle_status(
        SimpleNamespace(api_client=Client()), None,
    )
    try:
        with pytest.raises(ValueError):
            await anext(stream)
        await asyncio.sleep(0)
        assert not started
        assert not created
    finally:
        for task in created:
            task.cancel()
        await asyncio.gather(*created, return_exceptions=True)
        await stream.aclose()
