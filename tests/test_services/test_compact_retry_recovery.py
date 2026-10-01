"""Exercise repeated compaction failures through the public service entrypoint."""

import asyncio
from itertools import pairwise

import pytest

from myharness.api.client import ApiMessageCompleteEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage
from myharness.services.compact import (
    AutoCompactState,
    auto_compact_if_needed,
    compact_conversation,
    estimate_request_tokens,
)


def history():
    return [ConversationMessage.from_user_text("Evidence and constraints. " * 1000) for _ in range(8)]


@pytest.mark.asyncio
@pytest.mark.parametrize("reason", ["length", "max_tokens", "max_output_tokens"])
async def test_output_limit_retries_recover_without_adopting_partial_summary(reason):
    requests, events, billed = [], [], []
    original = history()
    before = [message.model_dump() for message in original]

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            complete = request.max_tokens >= 16000
            yield ApiMessageCompleteEvent(
                message=ConversationMessage(role="assistant", content=[{
                    "type": "text", "text": "Complete handoff." if complete else "PARTIAL DO NOT ADOPT",
                }]),
                usage=UsageSnapshot(output_tokens=10),
                stop_reason="stop" if complete else reason,
            )

    async def progress(event):
        events.append(event)

    result, changed = await auto_compact_if_needed(
        original, api_client=Client(), model="unregistered-model", state=AutoCompactState(),
        force=True, progress_callback=progress, usage_callback=billed.append,
    )
    assert changed
    assert [r.max_tokens for r in requests] == [4000, 8000, 16000]
    assert any("Complete handoff." in message.text for message in result)
    assert all("PARTIAL DO NOT ADOPT" not in message.text for message in result)
    assert [message.model_dump() for message in original] == before
    assert [e.phase for e in events].count("compact_end") == 1
    assert all(e.phase != "compact_failed" for e in events)
    assert sum(u.output_tokens for u in billed) == 30


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["timeout", "empty", "length"])
async def test_exhausted_retries_report_one_failure_and_preserve_history(failure, monkeypatch):
    monkeypatch.setattr("myharness.services.compact.COMPACT_TIMEOUT_SECONDS", 0.001)
    original, events, requests = history(), [], []
    before = [m.model_dump() for m in original]
    state = AutoCompactState()

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            if failure == "timeout":
                await asyncio.sleep(1)
            yield ApiMessageCompleteEvent(
                message=ConversationMessage.from_user_text("partial" if failure == "length" else ""),
                usage=UsageSnapshot(), stop_reason="length" if failure == "length" else "stop",
            )

    async def progress(event):
        events.append(event)

    result, changed = await auto_compact_if_needed(
        original, api_client=Client(), model="unregistered-model", state=state,
        force=True, progress_callback=progress,
    )
    assert not changed and result is original
    assert [m.model_dump() for m in original] == before
    assert len(requests) == 3 and state.consecutive_failures == 1
    failures = [e for e in events if e.phase == "compact_failed"]
    assert len(failures) == 1
    assert failures[0].message
    assert failures[0].metadata["original_history_retained"] is True
    if failure == "timeout":
        assert "timed out" in failures[0].message
    assert all(e.phase != "compact_end" for e in events)


@pytest.mark.asyncio
async def test_retry_output_growth_respects_configured_context_window():
    original, requests = history(), []
    window = 45000

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            yield ApiMessageCompleteEvent(
                message=ConversationMessage.from_user_text("partial"),
                usage=UsageSnapshot(), stop_reason="length",
            )

    await auto_compact_if_needed(
        original, api_client=Client(), model="unregistered-model", state=AutoCompactState(),
        force=True, context_window_tokens=window,
    )
    assert 4000 < requests[-1].max_tokens < 16000
    for request in requests[1:]:
        input_tokens = estimate_request_tokens(
            request.messages, model=request.model, system_prompt=request.system_prompt, tools=[],
        )
        assert input_tokens + request.max_tokens + 1024 <= window


@pytest.mark.asyncio
async def test_input_overflow_gets_all_three_reduced_input_retries():
    requests = []

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            if len(requests) <= 3:
                raise RuntimeError("context_length_exceeded")
            yield ApiMessageCompleteEvent(
                message=ConversationMessage.from_user_text("Complete recovery handoff"),
                usage=UsageSnapshot(), stop_reason="stop",
            )

    result = await compact_conversation(history(), api_client=Client(), model="unregistered-model")
    assert len(requests) == 4
    sizes = [estimate_request_tokens(r.messages, model=r.model) for r in requests]
    assert all(after < before for before, after in pairwise(sizes))
    assert "Complete recovery handoff" in result.summary_messages[0].text


@pytest.mark.asyncio
async def test_input_retries_do_not_consume_incomplete_response_retries():
    requests = []

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            if len(requests) in {2, 3, 4}:
                raise RuntimeError("context_length_exceeded")
            yield ApiMessageCompleteEvent(
                message=ConversationMessage.from_user_text("" if len(requests) == 1 else "Recovered"),
                usage=UsageSnapshot(), stop_reason="stop",
            )

    result = await compact_conversation(history(), api_client=Client(), model="unregistered-model")
    assert len(requests) == 5
    assert "Recovered" in result.summary_messages[0].text


@pytest.mark.asyncio
async def test_exhausted_input_reductions_keep_original_error_and_history():
    requests, events, original = [], [], history()

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            raise RuntimeError("context_length_exceeded")
            yield

    async def progress(event):
        events.append(event)

    result, changed = await auto_compact_if_needed(
        original, api_client=Client(), model="unregistered-model", state=AutoCompactState(),
        force=True, progress_callback=progress,
    )
    assert result is original and not changed
    assert len(requests) == 4
    failures = [e for e in events if e.phase == "compact_failed"]
    assert len(failures) == 1 and failures[0].message == "context_length_exceeded"


@pytest.mark.asyncio
async def test_severely_overfilled_summary_fits_budget_and_archives_original(tmp_path):
    requests, original = [], history() * 4
    original[0] = ConversationMessage.from_user_text("UNIQUE-OLD-EVIDENCE " + original[0].text)
    original.append(ConversationMessage.from_user_text("Continue."))
    metadata = {"session_id": "123456abcdef"}
    window = 32000

    class Client:
        async def stream_message(self, request):
            requests.append(request)
            size = estimate_request_tokens(request.messages, model=request.model, system_prompt=request.system_prompt)
            if size + request.max_tokens > window:
                raise RuntimeError("context_length_exceeded")
            yield ApiMessageCompleteEvent(
                message=ConversationMessage.from_user_text("Recovered handoff; older evidence is archived."),
                usage=UsageSnapshot(), stop_reason="stop",
            )

    result, changed = await auto_compact_if_needed(
        original, api_client=Client(), model="unregistered-model", state=AutoCompactState(),
        force=True, context_window_tokens=window, carryover_metadata=metadata, cwd=tmp_path,
    )
    assert changed and len(requests) == 2
    assert any("Recovered handoff" in m.text for m in result)
    from pathlib import Path
    checkpoint = next(d for d in metadata["session_documents"] if d["source_kind"] == "conversation_checkpoint")
    assert "UNIQUE-OLD-EVIDENCE" in Path(checkpoint["path"]).read_text()
