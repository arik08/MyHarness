"""Responses progress contracts shared by Codex and P-GPT transports."""
import json

import httpx
import pytest

from myharness.api.client import ApiMessageRequest, ApiMessageCompleteEvent, ApiReasoningSummaryEvent
from myharness.api.codex_client import CodexApiClient, OpenAIResponsesClient, _stop_reason_from_response


@pytest.mark.asyncio
@pytest.mark.parametrize("model", ["gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol", "future-model"])
@pytest.mark.parametrize("client_type", [CodexApiClient, OpenAIResponsesClient])
async def test_summary_reaches_consumer_before_item_or_response_finishes(model, client_type):
    summary = {"type": "reasoning", "id": "rs_1", "summary": [
        {"type": "summary_text", "text": "**누락값 확인**"},
        {"type": "summary_text", "text": "합계를 검산합니다."},
    ]}
    class Stream(httpx.AsyncByteStream):
        async def __aiter__(self):
            events = [
                {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "summary_index": 0, "delta": "**누락값"},
                {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "summary_index": 0, "delta": " 확인**"},
                {"type": "response.reasoning_summary_text.done", "item_id": "rs_1", "summary_index": 0, "text": "**누락값 확인**"},
                {"type": "response.reasoning_summary_text.delta", "item_id": "rs_1", "summary_index": 1, "delta": "합계를 검산합니다."},
                {"type": "response.output_item.done", "item": summary},
                {"type": "response.completed", "response": {"status": "completed", "output": [summary]}},
            ]
            for event in events:
                if event["type"] == "response.output_item.done":
                    assert len(received) == 3, "Progress was buffered until item completion"
                yield ("data: " + json.dumps(event) + "\n\n").encode()

    client = client_type("test")
    client._build_headers = lambda body: {}
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, stream=Stream())))
    received = []
    try:
        async for event in client.stream_message(ApiMessageRequest(model=model, messages=[])):
            if isinstance(event, ApiReasoningSummaryEvent):
                received.append(event)
    finally:
        await client.aclose()
    assert [event.text for event in received] == ["**누락값", "**누락값 확인**", "**누락값 확인**\n\n합계를 검산합니다."]
    assert len({event.summary_id for event in received}) == 1
    assert received[0].summary_id


@pytest.mark.asyncio
@pytest.mark.parametrize("json_body", [False, True])
async def test_gateway_completed_only_output_preserves_public_summary(json_body):
    payload = {"object": "response", "status": "completed", "output": [
        {"type": "reasoning", "id": "rs_1", "summary": [{"type": "summary_text", "text": "자료를 비교했습니다."}]},
        {"type": "message", "role": "assistant", "phase": "final_answer", "content": [{"type": "output_text", "text": "결론입니다."}]},
    ]}
    def handle(request):
        return httpx.Response(200, json=payload) if json_body else httpx.Response(200, text="data: " + json.dumps({"type": "response.completed", "response": payload}) + "\n\n")
    client = OpenAIResponsesClient("test", base_url="https://pgpt.invalid/v1")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        events = [event async for event in client.stream_message(ApiMessageRequest(model="gpt-6-luna", messages=[]))]
    finally:
        await client.aclose()
    assert [e.text for e in events if isinstance(e, ApiReasoningSummaryEvent)] == ["자료를 비교했습니다."]
    assert isinstance(events[-1], ApiMessageCompleteEvent)
    assert events[-1].message.text == "결론입니다."


@pytest.mark.asyncio
async def test_gateway_sse_event_header_and_optional_summary_rejection():
    requests = []
    def handle(request):
        body = json.loads(request.content)
        requests.append(body)
        if "summary" in body["reasoning"]:
            return httpx.Response(400, json={"error": {"message": "Unsupported parameter: reasoning.summary"}})
        return httpx.Response(200, text='event: response.completed\r\ndata: {"response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"OK"}]}]}}\r\n\r\n')
    client = OpenAIResponsesClient("test", base_url="https://pgpt.invalid/v1")
    client._http_client = httpx.AsyncClient(transport=httpx.MockTransport(handle))
    try:
        for _ in range(2):
            events = [event async for event in client.stream_message(ApiMessageRequest(model="gpt-6-luna", messages=[], reasoning_effort="high"))]
            assert events[-1].message.text == "OK"
    finally:
        await client.aclose()
    assert len(requests) == 3
    assert requests[0]["reasoning"]["summary"] == "detailed"
    assert requests[1]["reasoning"] == requests[2]["reasoning"] == {"effort": "high"}


@pytest.mark.parametrize("reason,expected", [(None, "length"), ("max_output_tokens", "length"), ("content_filter", "content_filter")])
def test_only_output_budget_exhaustion_requests_length_continuation(reason, expected):
    response = {"status": "incomplete", "incomplete_details": {"reason": reason}}
    assert _stop_reason_from_response(response, has_tool_calls=False) == expected
