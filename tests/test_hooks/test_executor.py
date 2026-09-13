"""Tests for hooks execution."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

import myharness.hooks.executor as hook_executor_module
from myharness.api.client import ApiMessageCompleteEvent, ApiRetryEvent, ApiTextDeltaEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock
from myharness.hooks import HookEvent, HookExecutionContext, HookExecutor
from myharness.hooks.executor import _inject_arguments
from myharness.hooks.loader import HookRegistry
from myharness.hooks.schemas import (
    AgentHookDefinition, CommandHookDefinition, HttpHookDefinition, PromptHookDefinition,
)


def make_model_hook_executor(tmp_path, client, definition, **kwargs):
    registry = HookRegistry()
    registry.register(HookEvent.PRE_TOOL_USE, definition(prompt="Check", **kwargs))
    return HookExecutor(
        registry,
        HookExecutionContext(cwd=tmp_path, api_client=client, default_model="test"),
    )


@pytest.mark.parametrize("definition", [PromptHookDefinition, AgentHookDefinition])
async def test_model_hook_accepts_retry_then_text(tmp_path, definition):
    class Client:
        async def stream_message(self, request):
            yield ApiRetryEvent(message="retry", attempt=1, max_attempts=3, delay_seconds=0)
            yield ApiTextDeltaEvent(text='{"ok": true}')

    executor = make_model_hook_executor(tmp_path, Client(), definition)
    result = await executor.execute(HookEvent.PRE_TOOL_USE, {})
    assert result.results[0].success
    assert result.results[0].output == '{"ok": true}'


@pytest.mark.parametrize("definition", [PromptHookDefinition, AgentHookDefinition])
@pytest.mark.parametrize("block", [True, False])
async def test_model_hook_timeout_closes_stream(tmp_path, definition, block):
    closed = asyncio.Event()

    class Client:
        async def stream_message(self, request):
            try:
                yield ApiTextDeltaEvent(text='{"ok":')
                await asyncio.Event().wait()
            finally:
                closed.set()

    executor = make_model_hook_executor(
        tmp_path, Client(), definition, timeout_seconds=1, block_on_failure=block,
    )
    result = await asyncio.wait_for(executor.execute(HookEvent.PRE_TOOL_USE, {}), 3)
    assert not result.results[0].success
    assert result.blocked is block
    assert "timed out after 1s" in result.results[0].reason
    assert closed.is_set()


@pytest.mark.parametrize("definition", [PromptHookDefinition, AgentHookDefinition])
@pytest.mark.parametrize("block", [True, False])
async def test_model_hook_provider_failure_is_a_hook_result(tmp_path, definition, block):
    class Client:
        async def stream_message(self, request):
            yield ApiTextDeltaEvent(text="")
            raise RuntimeError("provider unavailable")

    executor = make_model_hook_executor(tmp_path, Client(), definition, block_on_failure=block)
    result = await executor.execute(HookEvent.PRE_TOOL_USE, {})
    assert not result.results[0].success
    assert result.blocked is block
    assert result.results[0].reason == "provider unavailable"


@pytest.mark.parametrize("definition", [PromptHookDefinition, AgentHookDefinition])
async def test_model_hook_preserves_user_cancellation(tmp_path, definition):
    started = asyncio.Event()
    closed = asyncio.Event()

    class Client:
        async def stream_message(self, request):
            try:
                started.set()
                await asyncio.Event().wait()
                yield ApiTextDeltaEvent(text="")
            finally:
                closed.set()

    executor = make_model_hook_executor(tmp_path, Client(), definition)
    task = asyncio.create_task(executor.execute(HookEvent.PRE_TOOL_USE, {}))
    await asyncio.wait_for(started.wait(), 1)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert closed.is_set()


class FakeApiClient:
    """Minimal fake streaming client."""

    def __init__(self, text: str) -> None:
        self._text = text

    async def stream_message(self, request):
        del request
        yield ApiMessageCompleteEvent(
            message=ConversationMessage(role="assistant", content=[TextBlock(text=self._text)]),
            usage=UsageSnapshot(input_tokens=1, output_tokens=1),
            stop_reason=None,
        )


@pytest.mark.asyncio
async def test_command_hook_executes(tmp_path: Path):
    registry = HookRegistry()
    registry.register(
        HookEvent.SESSION_START,
        CommandHookDefinition(command="printf 'booted'"),
    )
    executor = HookExecutor(
        registry,
        HookExecutionContext(cwd=tmp_path, api_client=FakeApiClient('{"ok": true}'), default_model="claude-test"),
    )

    result = await executor.execute(HookEvent.SESSION_START, {"event": "session_start"})

    assert result.blocked is False
    assert result.results[0].output == "booted"


@pytest.mark.asyncio
async def test_prompt_hook_can_block(tmp_path: Path):
    registry = HookRegistry()
    registry.register(
        HookEvent.PRE_TOOL_USE,
        PromptHookDefinition(prompt="Check tool call", matcher="bash"),
    )
    executor = HookExecutor(
        registry,
        HookExecutionContext(
            cwd=tmp_path,
            api_client=FakeApiClient('{"ok": false, "reason": "blocked by policy"}'),
            default_model="claude-test",
        ),
    )

    result = await executor.execute(
        HookEvent.PRE_TOOL_USE,
        {"tool_name": "bash", "tool_input": {"command": "rm -rf ."}},
    )

    assert result.blocked is True
    assert result.reason == "blocked by policy"


@pytest.mark.asyncio
async def test_http_hook_streams_bounded_response_tail(tmp_path: Path, monkeypatch):
    registry = HookRegistry()
    registry.register(
        HookEvent.SESSION_START,
        HttpHookDefinition(url="https://example.test/hook"),
    )
    executor = HookExecutor(
        registry,
        HookExecutionContext(
            cwd=tmp_path,
            api_client=FakeApiClient('{"ok": true}'),
            default_model="claude-test",
        ),
    )

    transport = httpx.MockTransport(
        lambda request: httpx.Response(200, content=b"A" * 100_000 + b"final", request=request)
    )
    client = httpx.AsyncClient(transport=transport)
    monkeypatch.setattr(
        hook_executor_module.httpx,
        "AsyncClient",
        lambda **kwargs: client,
    )

    result = await executor.execute(HookEvent.SESSION_START, {"event": "session_start"})

    output = result.results[0].output
    assert len(output.encode("utf-8")) == hook_executor_module.HOOK_OUTPUT_TAIL_BYTES
    assert output.endswith("final")


# ---------------------------------------------------------------------------
# _inject_arguments shell escaping
# ---------------------------------------------------------------------------


def test_inject_arguments_no_escape_by_default():
    payload = {"command": "$(whoami)"}
    result = _inject_arguments("echo $ARGUMENTS", payload)
    # Without shell_escape, the raw JSON is substituted
    assert result == 'echo {"command": "$(whoami)"}'


def test_inject_arguments_shell_escape_wraps_in_single_quotes():
    payload = {"command": "$(whoami)"}
    result = _inject_arguments("echo $ARGUMENTS", payload, shell_escape=True)
    # With shell_escape, shlex.quote wraps the JSON in single quotes
    # so bash treats it as a literal string
    assert result.startswith("echo '")
    assert "$(whoami)" in result


@pytest.mark.asyncio
async def test_command_hook_escapes_shell_metacharacters(tmp_path: Path):
    """$ARGUMENTS in command hooks must be shell-escaped to prevent injection."""
    registry = HookRegistry()
    registry.register(
        HookEvent.PRE_TOOL_USE,
        CommandHookDefinition(command="echo $ARGUMENTS"),
    )
    executor = HookExecutor(
        registry,
        HookExecutionContext(
            cwd=tmp_path,
            api_client=FakeApiClient('{"ok": true}'),
            default_model="claude-test",
        ),
    )

    # $(echo INJECTED) would execute as a subshell if not properly escaped
    payload = {"tool_name": "test", "input": "$(echo INJECTED)"}
    result = await executor.execute(HookEvent.PRE_TOOL_USE, payload)

    output = result.results[0].output
    # With proper escaping, the literal $(echo INJECTED) must survive.
    # Without escaping, bash expands the subshell and the $() wrapper is gone.
    assert "$(echo INJECTED)" in output
