"""Request contracts for caching growing conversations and shared instructions."""

import json
from dataclasses import replace

import httpx
import pytest

from myharness.api.client import ApiMessageRequest
from myharness.api.codex_client import CodexApiClient, OpenAIResponsesClient
from myharness.api.openai_client import OpenAICompatibleClient
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import (
    ConversationMessage,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)
from myharness.services.session_storage import load_session_snapshot, save_session_snapshot


def _client(transport):
    if transport == "responses":
        return OpenAIResponsesClient(
            "test-key", base_url="https://gateway.invalid/v1", prompt_cache_retention="24h",
        )
    return OpenAICompatibleClient(
        api_key="test-key", enable_prompt_cache_options=True, include_usage_with_tools=True,
        prompt_cache_retention="24h",
    )


def _body(client, request):
    if isinstance(client, CodexApiClient):
        return client._request_body(request, request.messages)
    return client._completion_params(request)


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["responses", "chat", "codex"])
async def test_workspace_cache_routing_keeps_changing_facts_and_isolates_projects(transport):
    client = CodexApiClient("test-token") if transport == "codex" else _client(transport)
    request = ApiMessageRequest(
        model="gpt-6.1-sol", messages=[ConversationMessage.from_user_text("Continue")],
        system_prompt="Stable instructions.\nDate: 2026-09-30\nEffort: low",
        prompt_cache_scope="workspace-a",
    )
    try:
        initial = _body(client, request)
        changed = _body(client, replace(
            request, system_prompt="Stable instructions.\nDate: 2026-10-01\nEffort: high",
        ))
        assert changed["prompt_cache_key"] == initial["prompt_cache_key"]
        assert "2026-10-01" in json.dumps(changed)
        assert "Effort: high" in json.dumps(changed)
        assert _body(client, replace(request, prompt_cache_scope="workspace-b"))["prompt_cache_key"] != initial["prompt_cache_key"]
        assert _body(client, replace(request, tools=[{"name": "new_tool", "input_schema": {}}]))["prompt_cache_key"] != initial["prompt_cache_key"]
        # Non-runtime callers keep the prompt-sensitive default.
        unscoped = replace(request, prompt_cache_scope=None)
        assert _body(client, replace(unscoped, system_prompt="Different instructions"))["prompt_cache_key"] != _body(client, unscoped)["prompt_cache_key"]
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["responses", "chat"])
@pytest.mark.parametrize("model", ["gpt-5.6-sol", "gpt-6.1-sol", "vendor/GPT-6.2-luna"])
async def test_growing_history_is_cache_eligible_with_a_shared_static_boundary(transport, model):
    client = _client(transport)
    request = ApiMessageRequest(
        model=model, system_prompt="Stable office assistant instructions.",
        messages=[ConversationMessage.from_user_text("Find inventory records.")],
        tools=[{"name": "mcp__new_source__find", "input_schema": {"type": "object"}}],
    )
    try:
        first = _body(client, request)
        followup = _body(client, replace(request, messages=[
            *request.messages,
            ConversationMessage(role="assistant", content=[
                ToolUseBlock(id="call_1", name="mcp__new_source__find", input={"query": "steel"}),
            ]),
            ConversationMessage(role="user", content=[
                ToolResultBlock(tool_use_id="call_1", content="Retrieved inventory evidence."),
            ]),
            ConversationMessage(role="assistant", content=[TextBlock(text="Inventory checked.")]),
            ConversationMessage.from_user_text("Compare it with next quarter."),
        ]))
        assert followup["prompt_cache_options"] == {"mode": "implicit", "ttl": "30m"}
        assert "prompt_cache_retention" not in followup
        assert followup["tools"] == first["tools"]
        assert followup["prompt_cache_key"] == first["prompt_cache_key"]
        field = "input" if transport == "responses" else "messages"
        assert followup[field][:len(first[field])] == first[field]
        assert first[field][0]["content"][0]["prompt_cache_breakpoint"] == {"mode": "explicit"}
        assert "Retrieved inventory evidence." in json.dumps(followup[field])
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("transport", ["responses", "chat"])
@pytest.mark.parametrize("model", ["gpt-5.4", "gpt-5.5-pro", "custom-office-model"])
async def test_older_and_unknown_models_keep_their_existing_cache_contract(transport, model):
    client = _client(transport)
    try:
        body = _body(client, ApiMessageRequest(
            model=model, system_prompt="Stable instructions.",
            messages=[ConversationMessage.from_user_text("Hello")],
        ))
        assert "prompt_cache_options" not in body
        assert "prompt_cache_breakpoint" not in json.dumps(body)
        assert body["prompt_cache_retention"] == "24h"
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("rejected_option", ["prompt_cache_options", "prompt_cache_breakpoint"])
async def test_gateway_cache_option_rejection_recovers_without_dropping_conversation(rejected_option):
    seen = []

    def handle(request):
        body = json.loads(request.content)
        seen.append(body)
        if len(seen) == 1:
            return httpx.Response(400, json={"error": {"message": f"Unsupported {rejected_option}"}})
        return httpx.Response(200, json={
            "object": "response", "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "Evidence retained."},
            ]}],
            "usage": {"input_tokens": 100, "output_tokens": 3},
        })

    client = _client("responses")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    request = ApiMessageRequest(
        model="gpt-6.1-sol", system_prompt="Stable instructions.",
        messages=[ConversationMessage.from_user_text("Keep this evidence.")],
    )
    try:
        events = [event async for event in client.stream_message(request)]
        assert events[-1].message.text == "Evidence retained."
        assert len(seen) == 2
        assert seen[0]["prompt_cache_options"]["mode"] == "implicit"
        assert "prompt_cache_options" not in seen[1]
        assert "prompt_cache_breakpoint" not in json.dumps(seen[1])
        assert seen[1]["input"][1:] == seen[0]["input"][1:]
        assert seen[1]["prompt_cache_key"] == seen[0]["prompt_cache_key"]
        assert [event async for event in client.stream_message(request)]
        assert len(seen) == 3
        assert "prompt_cache_options" not in seen[-1]
    finally:
        await client.aclose()


@pytest.mark.asyncio
async def test_responses_static_prefix_and_history_survive_restore_and_new_session(tmp_path):
    messages = [
        ConversationMessage.from_user_text("Keep the original constraint."),
        ConversationMessage(role="assistant", content=[TextBlock(text="Original answer.")]),
    ]
    request = ApiMessageRequest(model="gpt-6.1-sol", system_prompt="Stable instructions.", messages=messages)
    first_client = _client("responses")
    restored_client = _client("responses")
    try:
        original = _body(first_client, request)
        save_session_snapshot(
            cwd=tmp_path, model=request.model, system_prompt=request.system_prompt,
            messages=messages, usage=UsageSnapshot(),
        )
        snapshot = load_session_snapshot(tmp_path)
        restored = [ConversationMessage.model_validate(item) for item in snapshot["messages"]]
        followup = _body(restored_client, replace(request, messages=[
            *restored, ConversationMessage.from_user_text("Continue with the same constraint."),
        ]))
        assert followup["input"][:-1] == original["input"]
        assert followup["prompt_cache_key"] == original["prompt_cache_key"]
        assert followup["prompt_cache_options"]["mode"] == "implicit"
        fresh = _body(restored_client, replace(request, messages=[ConversationMessage.from_user_text("New task.")]))
        assert fresh["input"][0] == original["input"][0]
        assert fresh["prompt_cache_key"] == original["prompt_cache_key"]
    finally:
        await first_client.aclose()
        await restored_client.aclose()


@pytest.mark.asyncio
async def test_responses_prewarm_keeps_the_real_prefix_and_does_not_mutate_history():
    seen = []

    def handle(request):
        seen.append(json.loads(request.content))
        return httpx.Response(200, json={
            "object": "response", "status": "completed",
            "output": [{"type": "message", "role": "assistant", "content": [
                {"type": "output_text", "text": "OK"},
            ]}],
            "usage": {"input_tokens": 100, "output_tokens": 1},
        })

    client = _client("responses")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    request = ApiMessageRequest(
        model="gpt-6.1-sol", system_prompt="Stable instructions.", max_tokens=512,
        messages=[ConversationMessage.from_user_text("Real customer request.")],
        tools=[{"name": "mcp__new_source__find", "input_schema": {"type": "object"}}],
    )
    original_history = [message.model_dump() for message in request.messages]
    try:
        assert await client.prewarm_prompt_cache(request)
        assert [message.model_dump() for message in request.messages] == original_history
        assert [event async for event in client.stream_message(request)]
        warmup, actual = seen
        assert warmup["input"][0] == actual["input"][0]
        assert warmup["tools"] == actual["tools"]
        assert warmup["prompt_cache_key"] == actual["prompt_cache_key"]
        assert warmup["prompt_cache_options"] == actual["prompt_cache_options"]
        assert warmup["max_output_tokens"] == 16
        assert actual["max_output_tokens"] == 512
        assert "Real customer request." not in json.dumps(warmup["input"])
    finally:
        await client.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["codex", "openai-responses", "P-GPT"])
async def test_cache_diagnostics_identify_the_route_without_recording_private_content(
    tmp_path, monkeypatch, provider,
):
    monkeypatch.setattr("myharness.config.paths.get_logs_dir", lambda: tmp_path)
    if provider == "codex":
        client = CodexApiClient("private-auth-token")
    else:
        client = OpenAIResponsesClient("private-auth-token", diagnostics_label=provider)
    request = ApiMessageRequest(
        model="gpt-6.1-sol", system_prompt="private-system-instructions",
        messages=[ConversationMessage.from_user_text("private-customer-input")],
        tools=[{"name": "mcp__new_source__find", "input_schema": {"type": "object"}}],
    )
    try:
        body = _body(client, request) if provider != "codex" else client._request_body(request, request.messages)
        client._write_cache_diagnostic(
            request, body, UsageSnapshot(input_tokens=100, cached_input_tokens=80, cache_write_tokens=5),
        )
        raw = (tmp_path / "prompt-cache-diagnostics.jsonl").read_text(encoding="utf-8")
        logged = json.loads(raw)
        assert logged["provider"] == provider
        assert logged["tool_count"] == 1
        assert logged["input_item_count"] == 2
        assert logged["prompt_cache_options"] == body.get("prompt_cache_options", {})
        assert logged["cache_hit_ratio"] == 0.8
        assert logged["uncached_input_tokens"] == 15
        for private_value in ("private-auth-token", "private-system-instructions", "private-customer-input"):
            assert private_value not in raw
    finally:
        await client.aclose()
