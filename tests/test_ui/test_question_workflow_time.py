import asyncio
import time
from types import SimpleNamespace

import pytest

from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost


@pytest.mark.asyncio
async def test_overlapping_questions_count_wait_once_and_cancel_resumes(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("myharness.ui.backend_host.time", SimpleNamespace(monotonic=lambda: now[0], time=time.time))
    host = ReactBackendHost(BackendHostConfig())
    async def emit(event):
        pass
    host._emit = emit
    first = asyncio.create_task(host._ask_question("First?"))
    await asyncio.sleep(0)
    now[0] = 110
    second = asyncio.create_task(host._ask_question("Second?"))
    await asyncio.sleep(0)
    now[0] = 120
    first_future = next(iter(host._question_requests.values()))
    first_future.set_result("answer")
    await first
    assert host._question_wait_elapsed(130) == 30
    now[0] = 140
    second.cancel()
    with pytest.raises(asyncio.CancelledError):
        await second
    assert host._question_wait_elapsed(200) == 40
    assert not host._question_requests


@pytest.mark.asyncio
async def test_failed_question_delivery_does_not_leave_timer_paused(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("myharness.ui.backend_host.time", SimpleNamespace(monotonic=lambda: now[0], time=time.time))
    host = ReactBackendHost(BackendHostConfig())
    async def emit(event):
        now[0] = 103
        raise RuntimeError("delivery failed")
    host._emit = emit
    with pytest.raises(RuntimeError):
        await host._ask_question("Question?")
    assert host._question_wait_elapsed(200) == 3
    assert host._question_wait_started_at is None


@pytest.mark.asyncio
async def test_final_saved_duration_excludes_wait_and_next_turn_starts_fresh(tmp_path, monkeypatch):
    from myharness.api.client import ApiMessageCompleteEvent
    from myharness.api.usage import UsageSnapshot
    from myharness.engine.messages import ConversationMessage, TextBlock, ToolUseBlock
    from myharness.ui.runtime import build_runtime, close_runtime, start_runtime

    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    now = [100.0]
    monkeypatch.setattr("myharness.ui.backend_host.time", SimpleNamespace(monotonic=lambda: now[0], time=time.time))

    class Provider:
        turns = 0
        async def stream_message(self, request):
            self.turns += 1
            now[0] += 5
            content = [ToolUseBlock(id="question-call", name="ask_user_question", input={"question": "자료 형식은?"})] if self.turns == 1 else [TextBlock(text="완료")]
            yield ApiMessageCompleteEvent(message=ConversationMessage(role="assistant", content=content), usage=UsageSnapshot())

    host = ReactBackendHost(BackendHostConfig())
    host._bundle = await build_runtime(api_client=Provider())
    async def emit(event):
        if event.type == "modal_request" and event.modal.get("kind") == "question":
            now[0] += 300
            host._question_requests[event.modal["request_id"]].set_result("보고서")
    host._emit = emit
    await start_runtime(host._bundle)
    try:
        await host._process_line("자료 작성")
        assert host._bundle.engine.tool_metadata["workflow_duration_seconds"] == 10
        assert next(item for item in reversed(host._history_events) if item["type"] == "line_complete")["workflow_duration_seconds"] == 10
        await host._process_line("다음 작업")
        assert host._bundle.engine.tool_metadata["workflow_duration_seconds"] == 5
    finally:
        await close_runtime(host._bundle)
