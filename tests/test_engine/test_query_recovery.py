"""Conversation recovery must retain effects and user input across interruptions."""

from __future__ import annotations

import asyncio
from dataclasses import replace

import pytest
from pydantic import BaseModel

from myharness.api.client import ApiMessageCompleteEvent
from myharness.api.codex_client import _convert_messages_to_codex
from myharness.api.errors import RequestFailure
from myharness.api.openai_client import _convert_messages_to_openai
from myharness.api.usage import UsageSnapshot
from myharness.config.settings import PermissionSettings
from myharness.engine.messages import ConversationMessage, TextBlock, ToolResultBlock, ToolUseBlock
from myharness.engine.query_engine import QueryEngine
from myharness.engine.stream_events import ErrorEvent, ToolExecutionCompleted
from myharness.permissions import PermissionChecker, PermissionMode
from myharness.tools.base import BaseTool, ToolRegistry, ToolResult


class _Input(BaseModel):
    pass


class _FixtureMutation(BaseTool):
    name = "new_fixture_mutation"
    description = "Records an isolated fixture effect."
    input_model = _Input

    def __init__(self, *, fails=False):
        self.calls = 0
        self.fails = fails

    def requires_project_mutation_lock(self, arguments):
        return False

    async def execute(self, arguments, context):
        self.calls += 1
        (context.cwd / "effect.txt").write_text(str(self.calls), encoding="utf-8")
        if self.fails:
            raise RuntimeError("fixture failed after its effect")
        return ToolResult(output="effect recorded")


class _WaitingTool(BaseTool):
    name = "new_fixture_wait"
    description = "Waits until its query is cancelled."
    input_model = _Input

    def __init__(self):
        self.started = asyncio.Event()
        self.closed = asyncio.Event()

    def is_read_only(self, arguments):
        return True

    async def execute(self, arguments, context):
        self.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.closed.set()


class _Provider:
    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    async def stream_message(self, request):
        self.requests.append(replace(request, messages=[message.model_copy(deep=True) for message in request.messages]))
        response = self.responses.pop(0)
        if isinstance(response, BaseException):
            raise response
        if response is None:
            return
        message, stop_reason = response
        yield ApiMessageCompleteEvent(message=message, usage=UsageSnapshot(input_tokens=1, output_tokens=1), stop_reason=stop_reason)


def _answer(text):
    return ConversationMessage(role="assistant", content=[TextBlock(text=text)]), "stop"


def _tool_turn(*tools):
    return ConversationMessage(role="assistant", content=[
        ToolUseBlock(id=f"call_{index}", name=tool.name, input={}) for index, tool in enumerate(tools)
    ]), "tool_use"


def _engine(tmp_path, client, *tools):
    registry = ToolRegistry()
    for tool in tools:
        registry.register(tool)
    return QueryEngine(
        api_client=client,
        tool_registry=registry,
        permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        cwd=tmp_path, model="test", system_prompt="system",
    )


def _results(messages):
    return [block for message in messages for block in message.content if isinstance(block, ToolResultBlock)]


def _start_query(engine, entrypoint):
    if entrypoint == "continue":
        engine.load_messages([
            ConversationMessage.from_user_text("previous task"),
            ConversationMessage(role="assistant", content=[ToolUseBlock(id="seed", name="previous_tool", input={})]),
            ConversationMessage(role="user", content=[ToolResultBlock(tool_use_id="seed", content="previous result")]),
        ])
        return engine.continue_pending()
    return engine.submit_message("perform the effect")


def _assert_provider_pairs(messages, expected_ids):
    assert [call.id for message in messages for call in message.tool_uses] == expected_ids
    assert [block.tool_use_id for block in _results(messages)] == expected_ids
    anthropic = [message.to_api_param() for message in messages]
    assert [block["tool_use_id"] for message in anthropic for block in message["content"] if block["type"] == "tool_result"] == expected_ids
    openai = _convert_messages_to_openai(messages, "system")
    assert [message["tool_call_id"] for message in openai if message["role"] == "tool"] == expected_ids
    codex = _convert_messages_to_codex(messages)
    assert [item["call_id"] for item in codex if item.get("type") == "function_call_output"] == expected_ids


@pytest.mark.asyncio
@pytest.mark.parametrize("provider_failure", [RequestFailure("fixture unavailable"), None])
@pytest.mark.parametrize("tool_fails", [False, True])
@pytest.mark.parametrize("entrypoint", ["submit", "continue"])
async def test_completed_tool_survives_provider_failure_and_resume(tmp_path, provider_failure, tool_fails, entrypoint):
    tool = _FixtureMutation(fails=tool_fails)
    provider = _Provider([_tool_turn(tool), provider_failure, _answer("recovered")])
    engine = _engine(tmp_path, provider, tool)
    stream = _start_query(engine, entrypoint)

    if provider_failure is None:
        with pytest.raises(RuntimeError, match="without a final message"):
            await _consume(stream)
    else:
        events = await _consume(stream)
        assert any(isinstance(event, ErrorEvent) for event in events)
    assert (tmp_path / "effect.txt").read_text(encoding="utf-8") == "1"
    expected_ids = (["seed"] if entrypoint == "continue" else []) + ["call_0"]
    _assert_provider_pairs(engine.messages, expected_ids)
    assert _results(engine.messages)[-1].is_error is tool_fails
    assert engine.has_pending_continuation()

    await _consume(engine.continue_pending())

    _assert_provider_pairs(provider.requests[-1].messages, expected_ids)
    assert tool.calls == 1
    assert engine.messages[-1].text == "recovered"
    assert not engine.has_pending_continuation()


async def _consume(stream):
    return [event async for event in stream]


@pytest.mark.asyncio
@pytest.mark.parametrize("interruption,parallel", [("close", False), ("close", True), ("cancel", True)])
@pytest.mark.parametrize("entrypoint", ["submit", "continue"])
async def test_completed_tool_survives_interruption_before_batch_finishes(tmp_path, parallel, interruption, entrypoint):
    mutation = _FixtureMutation()
    waiting = _WaitingTool()
    tools = [waiting, mutation] if parallel else [mutation]
    provider = _Provider([_tool_turn(*tools), _answer("recovered")])
    engine = _engine(tmp_path, provider, *tools)
    stream = _start_query(engine, entrypoint)
    while not isinstance(await asyncio.wait_for(anext(stream), timeout=2), ToolExecutionCompleted):
        pass

    if interruption == "cancel":
        task = asyncio.create_task(anext(stream))
        await asyncio.sleep(0)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task
    else:
        await stream.aclose()

    if parallel:
        assert waiting.started.is_set()
        assert waiting.closed.is_set()
    expected_ids = (["seed"] if entrypoint == "continue" else []) + [f"call_{index}" for index in range(len(tools))]
    _assert_provider_pairs(engine.messages, expected_ids)
    batch_results = _results(engine.messages)[-len(tools):]
    successful = [result for result in batch_results if not result.is_error]
    assert [result.content for result in successful] == ["effect recorded"]
    if parallel:
        interrupted = batch_results[0]
        assert interrupted.is_error and "effects are unknown" in interrupted.content
    assert engine.has_pending_continuation()

    await _consume(engine.continue_pending())

    _assert_provider_pairs(provider.requests[-1].messages, expected_ids)
    assert mutation.calls == 1
    assert engine.messages[-1].text == "recovered"


@pytest.mark.asyncio
async def test_worker_result_survives_parent_cancellation_before_completion_event(tmp_path):
    parent = None

    class CancellingMutation(_FixtureMutation):
        async def execute(self, arguments, context):
            result = await super().execute(arguments, context)
            asyncio.get_running_loop().call_soon(parent.cancel)
            return result

    waiting = _WaitingTool()
    mutation = CancellingMutation()
    provider = _Provider([_tool_turn(waiting, mutation), _answer("recovered")])
    engine = _engine(tmp_path, provider, waiting, mutation)
    events = []

    async def consume():
        async for event in engine.submit_message("perform the effect"):
            events.append(event)

    parent = asyncio.create_task(consume())
    with pytest.raises(asyncio.CancelledError):
        await asyncio.wait_for(parent, timeout=2)

    assert not any(isinstance(event, ToolExecutionCompleted) for event in events)
    assert waiting.closed.is_set()
    _assert_provider_pairs(engine.messages, ["call_0", "call_1"])
    assert _results(engine.messages)[1].content == "effect recorded"
    assert _results(engine.messages)[0].is_error
    await _consume(engine.continue_pending())
    assert mutation.calls == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("compact", [False, True])
async def test_auto_continuation_keeps_each_steering_message_in_saved_and_next_request(tmp_path, monkeypatch, compact):
    provider = _Provider([
        (ConversationMessage(role="assistant", content=[TextBlock(text="first")]), "length"),
        (ConversationMessage(role="assistant", content=[TextBlock(text=" second")]), "length"),
        _answer(" third"), _answer("next"),
    ])
    engine = _engine(tmp_path, provider)
    updates = {1: "use the revised source", 2: "include the latest numbers"}

    if compact:
        async def compact_once(messages, **kwargs):
            if len(provider.requests) == 1:
                # Compaction replaces the prefix and retains its recent tail.
                return [ConversationMessage.from_user_text("summary of draft"), *messages[-2:]], True
            return messages, False
        monkeypatch.setattr("myharness.services.compact.auto_compact_if_needed", compact_once)

    async def steering():
        update = updates.pop(len(provider.requests), None)
        return [update] if update else []

    await _consume(engine.submit_message("draft", steering_provider=steering))

    assert [message.text for message in engine.messages if message.role == "user"] == [
        "summary of draft" if compact else "draft", "use the revised source", "include the latest numbers",
    ]
    assert engine.messages[-1].text == "first second third"
    assert not any("continue" in message.text.lower() for message in engine.messages)

    await _consume(engine.submit_message("next request"))

    next_user_text = [message.text for message in provider.requests[-1].messages if message.role == "user"]
    assert next_user_text == ["summary of draft" if compact else "draft", "use the revised source", "include the latest numbers", "next request"]
