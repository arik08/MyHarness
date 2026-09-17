from types import SimpleNamespace
from unittest.mock import AsyncMock

import httpx
import pytest

from myharness.api.client import (
    AnthropicApiClient, ApiCompactionEvent, ApiMessageCompleteEvent, ApiMessageRequest,
    ApiReasoningSummaryEvent, ApiRetryEvent, ApiTextDeltaEvent, ApiToolCallDeltaEvent,
)
from myharness.api.codex_client import CodexApiClient
from myharness.api.errors import RequestFailure
from myharness.api.openai_client import OpenAICompatibleClient
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage


def make_client(provider, monkeypatch):
    monkeypatch.setattr("myharness.api.client._get_retry_delay", lambda *args, **kwargs: 0)
    monkeypatch.setattr("myharness.api.openai_client.calculate_retry_delay", lambda *args, **kwargs: 0)
    monkeypatch.setattr("myharness.api.codex_client.calculate_retry_delay", lambda *args, **kwargs: 0)
    if provider == "anthropic":
        return AnthropicApiClient(api_key="test-key")
    if provider == "codex":
        return CodexApiClient(auth_token="test-token")
    return OpenAICompatibleClient(api_key="test-key", raw_stream=provider == "openai-raw")


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["anthropic", "openai", "openai-raw", "codex"])
@pytest.mark.parametrize("partial", [
    ApiTextDeltaEvent(text="Partial response"),
    ApiToolCallDeltaEvent(index=0, name="write_file", arguments_delta='{"path":'),
    ApiReasoningSummaryEvent(text="Checking sources"),
    ApiCompactionEvent(phase="compact_start"),
    ApiMessageCompleteEvent(message=ConversationMessage.from_user_text("Complete"), usage=UsageSnapshot(), stop_reason=None),
])
async def test_interrupted_output_is_not_replayed(provider, partial, monkeypatch):
    client = make_client(provider, monkeypatch)
    calls = 0
    closed = 0

    async def stream(request):
        nonlocal calls, closed
        calls += 1
        try:
            yield partial
            error_type = OSError if provider == "anthropic" else httpx.ReadError
            raise error_type("connection interrupted")
        finally:
            closed += 1

    monkeypatch.setattr(client, "_stream_raw_once" if provider == "openai-raw" else "_stream_once", stream)
    events = []
    try:
        with pytest.raises(RequestFailure):
            async for event in client.stream_message(ApiMessageRequest(model="test-model", messages=[])):
                events.append(event)
        assert events == [partial]
        assert calls == closed == 1
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["anthropic", "openai", "openai-raw", "codex"])
async def test_transient_failure_before_output_still_retries(provider, monkeypatch):
    client = make_client(provider, monkeypatch)
    calls = 0

    async def stream(request):
        nonlocal calls
        calls += 1
        if calls == 1:
            error_type = OSError if provider == "anthropic" else httpx.ConnectError
            raise error_type("connection unavailable")
        yield ApiTextDeltaEvent(text="Recovered")

    monkeypatch.setattr(client, "_stream_raw_once" if provider == "openai-raw" else "_stream_once", stream)
    try:
        events = [event async for event in client.stream_message(ApiMessageRequest(model="test-model", messages=[]))]
        assert calls == 2
        assert len([event for event in events if isinstance(event, ApiRetryEvent)]) == 1
        assert [event.text for event in events if isinstance(event, ApiTextDeltaEvent)] == ["Recovered"]
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("stop_early", [False, True])
async def test_responses_route_keeps_output_and_closes_its_stream(stop_early):
    client = OpenAICompatibleClient(api_key="test-key", enable_gpt56_responses=True)
    closed = False
    fallback = AsyncMock()

    async def responses(request):
        nonlocal closed
        try:
            yield ApiTextDeltaEvent(text="Already started")
            raise RequestFailure("Responses request failed (404): not found")
        finally:
            closed = True

    client._responses_client = SimpleNamespace(stream_message=responses, aclose=AsyncMock())
    client._stream_once = fallback
    stream = client.stream_message(ApiMessageRequest(model="gpt-5.6-luna", messages=[]))
    try:
        assert (await anext(stream)).text == "Already started"
        if stop_early:
            await stream.aclose()
        else:
            with pytest.raises(RequestFailure):
                await anext(stream)
        assert closed
        fallback.assert_not_called()
        assert client.supports_server_compaction("gpt-5.6-luna")
    finally:
        await stream.aclose()
        await client.aclose()
