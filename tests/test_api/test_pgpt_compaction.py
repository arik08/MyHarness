"""P-GPT uses the Responses wire protocol, independently of Codex auth."""

import json

import httpx
import pytest

from myharness.api.client import ApiCompactionEvent, ApiMessageCompleteEvent, ApiMessageRequest
from myharness.api.codex_client import OpenAIResponsesClient
from myharness.api.errors import RequestFailure
from myharness.config.settings import (
    BUILTIN_MODEL_POLICIES,
    PermissionSettings,
    model_output_profile,
)
from myharness.context_policy import get_context_window
from myharness.engine.messages import ConversationMessage
from myharness.engine.query_engine import QueryEngine
from myharness.permissions import PermissionChecker, PermissionMode
from myharness.services.session_storage import load_session_by_id, save_session_snapshot
from myharness.tools.base import ToolRegistry

PGPT_MODELS = (*BUILTIN_MODEL_POLICIES["p-gpt"].allowed_models, "new-gateway-model")

def output(sequence=1):
    return [
        {"type": "compaction", "id": f"cmp_{sequence}", "encrypted_content": f"opaque-{sequence}"},
        {"type": "message", "id": f"msg_{sequence}", "role": "assistant", "phase": "final_answer",
         "content": [{"type": "output_text", "text": "Luna research continues."}]},
    ]


def response(items, mode="json"):
    payload = {"object": "response", "status": "completed", "output": items,
               "usage": {"input_tokens": 1000, "output_tokens": 20}}
    if mode == "json":
        return httpx.Response(200, json=payload)
    events = []
    if mode == "incremental":
        events = [{"type": "response.compaction.compacting"},
                  {"type": "response.output_item.added", "item": {"type": "compaction"}}]
        events += [{"type": "response.output_item.done", "item": item} for item in items]
    events.append({"type": "response.completed", "response": payload})
    return httpx.Response(200, text="".join("data: " + json.dumps(event) + "\n\n" for event in events))


@pytest.mark.asyncio
@pytest.mark.parametrize("model", PGPT_MODELS)
@pytest.mark.parametrize("mode", ["json", "terminal", "incremental"])
async def test_pgpt_native_compaction_survives_repeated_turns_and_disk_reload(tmp_path, monkeypatch, model, mode):
    requests = []

    def handle(request):
        assert request.url.path == "/v1/responses"
        assert request.headers["authorization"] == "Bearer pgpt-test-token"
        assert "chatgpt-account-id" not in request.headers
        body = json.loads(request.content)
        requests.append(body)
        assert body["context_management"] == [{"type": "compaction", "compact_threshold": 1000}]
        assert body["model"] == model
        if len(requests) > 1:
            states = [item for item in body["input"] if item.get("type") == "compaction"]
            assert states == [output(len(requests) - 1)[0]]
            assert "ORIGINAL-BULK" not in json.dumps(body["input"])
        return response(output(len(requests)), mode)

    async def no_local_summary(*args, **kwargs):
        pytest.fail("A supported P-GPT route must use native compaction before the physical limit")

    monkeypatch.setattr("myharness.services.compact.compact_conversation", no_local_summary)
    client = OpenAIResponsesClient("pgpt-test-token", base_url="https://pgpt.invalid/v1", diagnostics_label="P-GPT")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))

    def engine(metadata):
        return QueryEngine(
            api_client=client, model=model, system_prompt="Continue Luna research.", cwd=tmp_path,
            tool_registry=ToolRegistry(), permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
            auto_compact_threshold_tokens=1000, max_tokens=1024,
            tool_metadata=metadata, auto_skill_learning_enabled=False,
        )

    metadata = {"session_id": "abc123abc123", "session_title": "Luna research"}
    current = engine(metadata)
    current.load_messages([ConversationMessage.from_user_text("Luna research ORIGINAL-BULK " * 2000)])
    try:
        for turn in range(3):
            events = [event async for event in current.submit_message("Continue Luna research.")]
            assert not any(type(e).__name__ == "ErrorEvent" for e in events)
            phases = [e.phase for e in events if type(e).__name__ == "CompactProgressEvent"]
            assert phases == ["compact_start", "compact_end"]
            assert current.messages[-1].text == "Luna research continues."
            save_session_snapshot(cwd=tmp_path, model=model, system_prompt="Continue Luna research.",
                                  messages=current.messages, usage=current.total_usage,
                                  session_id=metadata["session_id"], tool_metadata=current.tool_metadata)
            snapshot = load_session_by_id(tmp_path, metadata["session_id"])
            assert snapshot["summary"] == "Luna research"
            current = engine(snapshot["tool_metadata"])
            current.load_messages([ConversationMessage.model_validate(m) for m in snapshot["messages"]])
    finally:
        await client.aclose()
    assert len(requests) == 3


@pytest.mark.asyncio
async def test_gateway_rejection_disables_compaction_only_for_rejected_model():
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        if body["model"] == "legacy-model" and "context_management" in body:
            return httpx.Response(400, json={"error": {"message": "Unsupported parameter: context_management"}})
        return response(output()[1:])

    client = OpenAIResponsesClient("pgpt-test-token", base_url="https://pgpt.invalid/v1")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        for model in ["legacy-model", "legacy-model", "gpt-6-luna"]:
            events = [e async for e in client.stream_message(ApiMessageRequest(model=model, messages=[]))]
            assert isinstance(events[-1], ApiMessageCompleteEvent)
        assert not client.supports_server_compaction("legacy-model")
        assert client.supports_server_compaction("gpt-6-luna")
    finally:
        await client.aclose()
    assert ["context_management" in body for body in requests] == [True, False, False, True]


@pytest.mark.asyncio
@pytest.mark.parametrize("status,message", [(400, "Invalid context_management.compact_threshold: too small"),
                                            (401, "context_management not permitted")])
@pytest.mark.parametrize("model", PGPT_MODELS)
async def test_invalid_threshold_or_auth_does_not_disable_compaction(status, message, model):
    client = OpenAIResponsesClient("pgpt-test-token")
    calls = []
    def handle(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": message}})
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        with pytest.raises(Exception, match=message.split(":")[0]):
            _ = [e async for e in client.stream_message(ApiMessageRequest(model=model, messages=[]))]
        assert client.supports_server_compaction(model)
    finally:
        await client.aclose()
    assert len(calls) == 1


@pytest.mark.asyncio
@pytest.mark.parametrize("encrypted", [None, "", " "])
@pytest.mark.parametrize("model", PGPT_MODELS)
async def test_gateway_empty_compaction_state_is_not_committed(encrypted, model):
    items = output()
    items[0]["encrypted_content"] = encrypted
    client = OpenAIResponsesClient("pgpt-test-token")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(lambda request: response(items)))
    events = []
    try:
        with pytest.raises(RequestFailure, match="Invalid or incomplete"):
            async for event in client.stream_message(ApiMessageRequest(model=model, messages=[])):
                events.append(event)
    finally:
        await client.aclose()
    assert not any(isinstance(e, ApiMessageCompleteEvent) or
                   isinstance(e, ApiCompactionEvent) and e.phase == "compact_end" for e in events)


@pytest.mark.asyncio
@pytest.mark.parametrize("model", PGPT_MODELS)
async def test_multiple_gateway_compactions_replay_only_latest_boundary(model):
    requests = []
    def handle(request):
        requests.append(json.loads(request.content))
        return response([*output(1), *output(2)]) if len(requests) == 1 else response(output(3)[1:])
    client = OpenAIResponsesClient("pgpt-test-token")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        events = [e async for e in client.stream_message(ApiMessageRequest(model=model, messages=[]))]
        message = events[-1].message
        _ = [e async for e in client.stream_message(ApiMessageRequest(model=model, messages=[message]))]
    finally:
        await client.aclose()
    states = [item for item in requests[1]["input"] if item.get("type") == "compaction"]
    assert states == [output(2)[0]]
    assert [e.phase for e in events if isinstance(e, ApiCompactionEvent)] == ["compact_start", "compact_end"]


@pytest.mark.asyncio
@pytest.mark.parametrize("model", PGPT_MODELS)
async def test_unsupported_pgpt_compaction_recovers_on_same_responses_route(tmp_path, model):
    requests = []
    def handle(request):
        assert request.url.path == "/v1/responses"
        body = json.loads(request.content)
        requests.append(body)
        if "context_management" in body:
            return httpx.Response(400, json={"error": {"message": "Unsupported parameter context_management"}})
        if len(requests) == 2:
            return httpx.Response(400, json={"error": {"message": "Input exceeds context window"}})
        return response(output()[1:])
    client = OpenAIResponsesClient("pgpt-test-token", base_url="https://pgpt.invalid/v1")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    engine = QueryEngine(
        api_client=client, model=model, system_prompt="Luna research", cwd=tmp_path,
        tool_registry=ToolRegistry(), permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        auto_compact_threshold_tokens=10000, max_tokens=1024, auto_skill_learning_enabled=False,
    )
    engine.load_messages([ConversationMessage.from_user_text("Old research evidence " * 1000) for _ in range(8)])
    try:
        events = [e async for e in engine.submit_message("Continue.")]
    finally:
        await client.aclose()
    assert not any(type(e).__name__ == "ErrorEvent" for e in events)
    assert engine.messages[-1].text == "Luna research continues."
    assert ["context_management" in r for r in requests] == [True, False, False, False]
    phases = [(e.phase, e.trigger) for e in events if type(e).__name__ == "CompactProgressEvent"]
    assert ("compact_end", "reactive") in phases


@pytest.mark.parametrize("model", ["gpt-6-luna", "gpt-6-sol", "openai/gpt-6-luna"])
def test_gpt6_context_does_not_fall_back_to_unknown_model_limit(model):
    assert get_context_window(model) == 1_050_000
    assert model_output_profile(model).model_max_output_tokens == 128_000
    assert get_context_window(model, context_window_tokens=272000) == 272000


@pytest.mark.asyncio
@pytest.mark.parametrize("model", PGPT_MODELS)
async def test_pgpt_compaction_survives_output_limit_continuation(tmp_path, model):
    requests = []

    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        assert body["model"] == model
        assert "context_management" in body
        if len(requests) == 1:
            return httpx.Response(200, json={
                "object": "response", "status": "incomplete",
                "incomplete_details": {"reason": "max_output_tokens"},
                "output": output()[1:],
                "usage": {"input_tokens": 100, "output_tokens": 1024},
            })
        if len(requests) == 3:
            assert [i for i in body["input"] if i.get("type") == "compaction"] == [output()[0]]
            assert "ORIGINAL-BULK" not in json.dumps(body["input"])
        return response(output())

    client = OpenAIResponsesClient("pgpt-test-token", base_url="https://pgpt.invalid/v1")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    engine = QueryEngine(
        api_client=client, model=model, system_prompt="Continue research.", cwd=tmp_path,
        tool_registry=ToolRegistry(),
        permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        auto_compact_threshold_tokens=10000, max_tokens=1024, auto_skill_learning_enabled=False,
    )
    try:
        events = [e async for e in engine.submit_message("ORIGINAL-BULK research")]
        assert not any(type(e).__name__ == "ErrorEvent" for e in events)
        assert engine.messages[-1].text == "Luna research continues." * 2
        events = [e async for e in engine.submit_message("Next turn")]
        assert not any(type(e).__name__ == "ErrorEvent" for e in events)
    finally:
        await client.aclose()
    assert len(requests) == 3
