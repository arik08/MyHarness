"""Tests for the POSCO P-GPT client."""

from __future__ import annotations

import base64
import json

import httpx
import pytest

from openharness.api.client import ApiMessageCompleteEvent, ApiMessageRequest
from openharness.api.posco_client import (
    PoscoGptClient,
    build_posco_auth_token,
    convert_messages_to_posco,
    extract_posco_payload,
    parse_posco_assistant_message,
)
from openharness.engine.messages import ConversationMessage, ImageBlock, TextBlock, ToolUseBlock


def test_posco_auth_token_matches_sample_encoding():
    expected = base64.b64encode(
        json.dumps({"apiKey": "key-1", "empNo": "12345", "compNo": "30"}).encode("utf-8")
    ).decode("utf-8")

    assert build_posco_auth_token("key-1", "12345", "30") == expected


def test_extract_posco_payload_handles_top_level_json():
    raw = {"type": "message", "content": "안녕하세요", "calls": []}

    assert extract_posco_payload(raw) == raw


def test_extract_posco_payload_handles_openai_like_string_json():
    payload = {"type": "message", "content": "done", "calls": []}
    raw = {"choices": [{"message": {"content": json.dumps(payload)}}]}

    assert extract_posco_payload(raw) == payload


def test_parse_tool_calls_to_tool_use_blocks():
    message = parse_posco_assistant_message(
        {
            "type": "tool_calls",
            "content": "",
            "calls": [
                {
                    "id": "call_1",
                    "name": "read_file",
                    "input": {"path": "README.md"},
                }
            ],
        },
        tools_expected=True,
    )

    assert message.role == "assistant"
    assert len(message.content) == 1
    assert isinstance(message.content[0], ToolUseBlock)
    assert message.content[0].id == "call_1"
    assert message.content[0].name == "read_file"
    assert message.content[0].input == {"path": "README.md"}


def test_convert_messages_to_posco_keeps_image_url_payload():
    message = ConversationMessage.from_user_content(
        [
            TextBlock(text="이 이미지를 분석해줘."),
            ImageBlock(media_type="image/png", data="abc123", source_path="sample.png"),
        ]
    )

    converted = convert_messages_to_posco([message])

    assert converted == [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "이 이미지를 분석해줘."},
                {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}},
            ],
        }
    ]


@pytest.mark.asyncio
async def test_posco_client_posts_expected_body_and_parses_answer():
    seen: dict[str, object] = {}

    async def _handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["Authorization"]
        seen["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={"choices": [{"message": {"content": "완료했습니다."}}]},
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    client = PoscoGptClient(
        "api-key",
        emp_no="E123",
        comp_no="30",
        base_url="https://pgpt.example.test/personalApi",
        http_client=http_client,
    )

    request = ApiMessageRequest(
        model="gpt-5.4-mini",
        system_prompt="도움말",
        messages=[ConversationMessage.from_user_text("안녕")],
    )
    events = [event async for event in client.stream_message(request)]

    assert seen["url"] == "https://pgpt.example.test/personalApi"
    assert seen["auth"] == f"Bearer {build_posco_auth_token('api-key', 'E123', '30')}"
    body = seen["body"]
    assert isinstance(body, dict)
    assert body["model"] == "gpt-5.4-mini"
    assert body["need_origin"] is True
    assert "response_format" not in body
    assert body["messages"][0] == {"role": "system", "content": "도움말"}
    assert body["messages"][1] == {"role": "user", "content": "안녕"}
    complete = [event for event in events if isinstance(event, ApiMessageCompleteEvent)][0]
    assert complete.message.content == [TextBlock(text="완료했습니다.")]

    await http_client.aclose()


@pytest.mark.asyncio
async def test_posco_client_sends_schema_for_tools():
    seen: dict[str, object] = {}

    async def _handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            json={
                "type": "tool_calls",
                "content": "",
                "calls": [{"id": "call_1", "name": "read_file", "input": {"path": "README.md"}}],
            },
        )

    http_client = httpx.AsyncClient(transport=httpx.MockTransport(_handler))
    client = PoscoGptClient(
        "api-key",
        emp_no="E123",
        base_url="https://pgpt.example.test/personalApi",
        http_client=http_client,
    )

    request = ApiMessageRequest(
        model="gpt-5.4-mini",
        messages=[ConversationMessage.from_user_text("README 읽어줘")],
        tools=[
            {
                "name": "read_file",
                "description": "Read a file",
                "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}},
            }
        ],
    )
    events = [event async for event in client.stream_message(request)]

    body = seen["body"]
    assert isinstance(body, dict)
    assert body["response_format"]["type"] == "json_schema"
    complete = [event for event in events if isinstance(event, ApiMessageCompleteEvent)][0]
    assert complete.message.tool_uses[0].name == "read_file"
    assert complete.message.tool_uses[0].input == {"path": "README.md"}

    await http_client.aclose()
