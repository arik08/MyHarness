"""Composer preferences and draft-only improvement contracts."""
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import ValidationError
from myharness.api.client import ApiMessageCompleteEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost, _format_compose_options_note
from myharness.ui.protocol import FrontendComposeOptions, FrontendRequest


@pytest.mark.parametrize("depth", ["brief", "standard", "deep"])
@pytest.mark.parametrize("length", ["brief", "standard", "detailed"])
def test_chat_preferences_are_independent_of_artifact_budget(depth, length):
    options = FrontendComposeOptions(analysis_depth=depth, answer_length=length, target_output_tokens=12000)
    note = _format_compose_options_note(options)
    assert "Analysis scope:" in note and "Chat answer length:" in note
    assert "12,000 tokens" in note
    assert "does not change the target length of generated files" in note
    assert "Target artifact" not in _format_compose_options_note(options.model_copy(update={"output_surface": "chat"}))


def test_unknown_preferences_are_rejected():
    with pytest.raises(ValidationError):
        FrontendComposeOptions(analysis_depth="invented")


@pytest.mark.asyncio
@pytest.mark.parametrize("queue", ["_queue_steering_line", "_queue_line_after_current", "_queue_follow_up_line"])
async def test_queued_preferences_reach_execution_without_leaking_into_transcript(queue):
    host = ReactBackendHost(BackendHostConfig())
    host._emit = AsyncMock()
    options = FrontendComposeOptions(analysis_depth="deep", answer_length="brief")
    await getattr(host, queue)("사용자 원문", "request-1", options)
    for call in host._emit.call_args_list:
        if call.args[0].item:
            assert call.args[0].item.text == "사용자 원문"
    if queue == "_queue_steering_line":
        lines = await host._drain_steering_lines()
        assert "Analysis scope:" in lines[0] and "사용자 원문" in lines[0]
    else:
        await host._promote_next_queued_line()
        request = host._request_queue.get_nowait()
        assert request.line == "사용자 원문" and request.compose_options == options


@pytest.mark.asyncio
@pytest.mark.parametrize("outcome", ["ok", "empty", "error", "length", "busy"])
async def test_enhancement_never_executes_draft_or_changes_history(outcome):
    calls = []
    history = [ConversationMessage.from_user_text("기존 대화")]
    class Client:
        async def stream_message(self, request):
            calls.append(request)
            if outcome == "error":
                raise RuntimeError("provider unavailable")
            yield ApiMessageCompleteEvent(message=ConversationMessage.from_user_text("" if outcome == "empty" else "개선한 요청"), usage=UsageSnapshot(input_tokens=2, output_tokens=3), stop_reason="max_tokens" if outcome == "length" else "end_turn")
    host = ReactBackendHost(BackendHostConfig())
    host._bundle = SimpleNamespace(engine=SimpleNamespace(model="test-model", messages=history), api_client=Client())
    host._emit = AsyncMock()
    host._busy = outcome == "busy"
    await host._enhance_prompt(FrontendRequest(type="enhance_prompt", line="파일을 만들어줘", request_id="id", enhancement_options=["structure", "evidence"]))
    event = host._emit.call_args.args[0]
    assert event.type == "prompt_enhanced" and event.request_id == "id"
    assert bool(event.is_error) == (outcome != "ok")
    assert host._bundle.engine.messages is history and len(history) == 1
    if calls:
        assert calls[0].tools == []
        assert "Do not answer or execute" in calls[0].system_prompt
    else:
        assert outcome == "busy"
