import json

import httpx
import pytest

from myharness.api.client import ApiMessageRequest, ApiMessageCompleteEvent
from myharness.api.codex_client import OpenAIResponsesClient, _convert_messages_to_codex
from myharness.api.errors import RequestFailure
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock, ResponsesStateBlock, ImageBlock
from myharness.services.compact import (
    AutoCompactState, auto_compact_if_needed, compact_conversation,
    estimate_message_tokens, get_autocompact_threshold,
)
from myharness.services.session_storage import save_session_snapshot, load_session_snapshot


def output():
    return [
        {"type": "reasoning", "id": "rs_1", "summary": []},
        {"type": "message", "id": "msg_1", "role": "assistant", "phase": "final_answer",
         "content": [{"type": "output_text", "text": "POSCO reply"}]},
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize("json_body", [False, True])
@pytest.mark.parametrize("with_done", [False, True])
async def test_pgpt_completed_output_and_cache_usage(json_body, with_done):
    payload = {"object": "response", "status": "completed", "output": output(),
               "usage": {"input_tokens": 100, "output_tokens": 1806,
                         "input_tokens_details": {"cached_tokens": 80, "cache_write_tokens": 10},
                         "output_tokens_details": {"reasoning_tokens": 1344}}}
    requests = []
    def handle(request):
        requests.append(request)
        if json_body:
            return httpx.Response(200, json=payload)
        events = [{"type": "response.output_item.done", "item": item} for item in output()] if with_done else []
        events.append({"type": "response.completed", "response": payload})
        return httpx.Response(200, text="\r\n\r\n".join("data: " + json.dumps(e) for e in events))
    client = OpenAIResponsesClient("test-key", base_url="https://gateway.invalid/v1")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        events = [e async for e in client.stream_message(ApiMessageRequest(model="gpt-5", messages=[]))]
    finally:
        await client.aclose()
    done = events[-1]
    assert done.message.text == "POSCO reply"
    assert len(done.message.content) == 2
    assert done.usage.output_tokens == 1806
    assert done.usage.cached_input_tokens == 80
    assert done.usage.cache_write_tokens == 10
    assert requests[0].url.path == "/v1/responses"
    assert _convert_messages_to_codex([done.message])[-1]["phase"] == "final_answer"


@pytest.mark.asyncio
async def test_eof_is_not_success_or_automatic_duplicate_retry():
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(200, text='data: {"type":"response.output_text.delta","delta":"partial"}\n\n')
    client = OpenAIResponsesClient("test-key")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        with pytest.raises(RequestFailure, match="completion event"):
            async for _ in client.stream_message(ApiMessageRequest(model="gpt-5", messages=[])):
                pass
    finally:
        await client.aclose()
    assert len(calls) == 1


def test_replay_preserves_boundaries_phase_and_snapshot(tmp_path):
    messages = [ConversationMessage(role="assistant", content=[
        TextBlock(text="before", response_item={"id": "msg_old", "phase": "commentary"}),
        ResponsesStateBlock(item={"type": "compaction", "encrypted_content": "opaque"}),
        TextBlock(text="after", response_item={"id": "msg_new", "phase": "final_answer"}),
    ])]
    expected = _convert_messages_to_codex(messages)
    assert [item["type"] for item in expected] == ["compaction", "message"]
    assert expected[-1]["content"][0]["text"] == "after"
    for _ in range(2):
        save_session_snapshot(cwd=tmp_path, model="gpt-5", system_prompt="system", messages=messages, usage=UsageSnapshot())
        snapshot = load_session_snapshot(tmp_path)
        messages = [ConversationMessage.model_validate(m) for m in snapshot["messages"]]
        assert _convert_messages_to_codex(messages) == expected


def test_nontext_and_physical_override_budget():
    assert estimate_message_tokens([ConversationMessage(role="user", content=[ImageBlock(media_type="image/png", data="AA==")])]) > 0
    assert estimate_message_tokens([ConversationMessage(role="assistant", content=[ResponsesStateBlock(item={"type": "compaction", "encrypted_content": "x" * 10000})])]) > 0
    assert get_autocompact_threshold("unknown", context_window_tokens=20000, auto_compact_threshold_tokens=100000) < 20000


@pytest.mark.asyncio
async def test_partial_summary_keeps_original_and_archives_middle(tmp_path):
    marker = "DO_NOT_PUBLISH_1942"
    messages = [ConversationMessage.from_user_text("text " * 3000 + marker + " text" * 3000)]
    messages += [ConversationMessage.from_user_text(f"turn {i}") for i in range(10)]
    original = [m.model_dump() for m in messages]
    class Partial:
        async def stream_message(self, request):
            yield ApiMessageCompleteEvent(message=ConversationMessage(role="assistant", content=[TextBlock(text="unfinished")]), usage=UsageSnapshot(), stop_reason="length")
    metadata = {"session_id": "abc123194200"}
    result, changed = await auto_compact_if_needed(messages, api_client=Partial(), model="gpt-5",
        state=AutoCompactState(), force=True, carryover_metadata=metadata, cwd=tmp_path)
    assert not changed
    assert [m.model_dump() for m in result] == original
    assert marker in str(metadata["user_input_archive"])
    from pathlib import Path
    assert marker in Path(metadata["session_documents"][0]["path"]).read_text(encoding="utf-8")


def test_unregistered_tool_output_is_recoverable(tmp_path):
    from pathlib import Path
    from myharness.engine.messages import ToolResultBlock
    from myharness.services.compact import try_tool_output_document_compaction
    metadata = {"session_id": "abc123456789"}
    source = "source=https://example.org/report\n" + "revenue=1942 KRW period=2025\n" * 4000
    result = try_tool_output_document_compaction(ToolResultBlock(tool_use_id="new-call", content=source, is_error=True),
        tool_name="mcp__new_vendor__new_dataset", tool_input={}, cwd=tmp_path, model="gpt-5", metadata=metadata)
    assert result is not None and result.is_error
    assert result.tool_use_id == "new-call"
    assert len(result.content) < len(source)
    entry = metadata["session_documents"][0]
    assert entry["id"] in result.content
    assert Path(entry["path"]).read_text(encoding="utf-8") == source


@pytest.mark.asyncio
async def test_unsupported_optional_compaction_never_falls_back_to_chat():
    from myharness.api.codex_client import CodexApiClient
    class Client(CodexApiClient):
        def _build_headers(self, body):
            return {}
    calls = []
    def handle(request):
        body = json.loads(request.content)
        calls.append(body)
        assert request.url.path.endswith("/responses")
        if "context_management" in body:
            return httpx.Response(400, json={"error": {"message": "unsupported context_management"}})
        return httpx.Response(200, text='data: ' + json.dumps({"type": "response.completed", "response": {
            "status": "completed", "output": output()}}) + '\n\n')
    client = Client("test")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        events = [e async for e in client.stream_message(ApiMessageRequest(model="gpt-5.6-sol", messages=[]))]
        assert not client.supports_server_compaction("gpt-5.6-sol")
    finally:
        await client.aclose()
    assert len(calls) == 2 and events[-1].message.text == "POSCO reply"


@pytest.mark.asyncio
async def test_native_compaction_eof_never_reports_success():
    from myharness.api.client import ApiCompactionEvent
    item = {"type": "compaction", "encrypted_content": "opaque"}
    client = OpenAIResponsesClient("test")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request:
        httpx.Response(200, text='data: ' + json.dumps({"type": "response.output_item.done", "item": item}) + '\n\n')))
    phases = []
    try:
        with pytest.raises(RequestFailure):
            async for event in client.stream_message(ApiMessageRequest(model="gpt-5", messages=[])):
                if isinstance(event, ApiCompactionEvent):
                    phases.append(event.phase)
    finally:
        await client.aclose()
    assert phases == ["compact_start"]


@pytest.mark.asyncio
async def test_two_semantic_compactions_resume_with_same_request(tmp_path):
    class Summary:
        async def stream_message(self, request):
            yield ApiMessageCompleteEvent(message=ConversationMessage(role="assistant", content=[
                TextBlock(text="<summary>Goal: evaluate report. Constraint: do not publish. Pending: verify sources.</summary>")]),
                usage=UsageSnapshot(input_tokens=1000, output_tokens=30), stop_reason="stop")
    metadata = {"session_id": "abc123abc123"}
    messages = [ConversationMessage.from_user_text("Do not publish the report.")]
    for cycle in range(2):
        messages.extend(ConversationMessage.from_user_text(f"source {cycle}-{i}: " + "evidence " * 2000) for i in range(10))
        messages.append(ConversationMessage.from_user_text("Continue verification."))
        messages, changed = await auto_compact_if_needed(messages, api_client=Summary(), model="gpt-5",
            state=AutoCompactState(), force=True, carryover_metadata=metadata, cwd=tmp_path)
        assert changed
        before = _convert_messages_to_codex(messages, developer_instructions="system")
        save_session_snapshot(cwd=tmp_path, model="gpt-5", system_prompt="system", messages=messages,
                              usage=UsageSnapshot(), tool_metadata=metadata)
        saved = load_session_snapshot(tmp_path)
        messages = [ConversationMessage.model_validate(message) for message in saved["messages"]]
        assert _convert_messages_to_codex(messages, developer_instructions="system") == before
        assert "Do not publish" in str(saved["tool_metadata"]["user_input_archive"])
    assert len(metadata["session_documents"]) == 2
