"""POSCO P-GPT API client.

P-GPT exposes a JSON-schema chat endpoint but does not provide native tool
calling.  This client keeps the OpenHarness engine contract by asking P-GPT for
a small structured response when tools are available, then translating that JSON
into the same ``ToolUseBlock`` objects native providers return.
"""

from __future__ import annotations

import base64
import json
import os
from typing import Any, AsyncIterator
from uuid import uuid4

import httpx

from openharness.api.client import (
    ApiMessageCompleteEvent,
    ApiMessageRequest,
    ApiStreamEvent,
    ApiTextDeltaEvent,
)
from openharness.api.errors import AuthenticationFailure, RequestFailure
from openharness.api.usage import UsageSnapshot
from openharness.auth.storage import load_credential
from openharness.engine.messages import (
    ConversationMessage,
    ImageBlock,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
)

DEFAULT_POSCO_GPT_BASE_URL = "http://pgpt.posco.com/s0la01-gpt/gptApi/personalApi"
DEFAULT_POSCO_GPT_MODEL = "gpt-5.4-mini"


def build_posco_auth_token(api_key: str, emp_no: str, comp_no: str = "30") -> str:
    """Return the bearer token required by P-GPT."""
    auth_data = {
        "apiKey": api_key,
        "empNo": emp_no,
        "compNo": comp_no,
    }
    raw = json.dumps(auth_data).encode("utf-8")
    return base64.b64encode(raw).decode("utf-8")


def resolve_posco_emp_no() -> str | None:
    """Resolve the P-GPT employee number from env or stored credentials."""
    return (
        os.environ.get("POSCO_EMP_NO")
        or os.environ.get("PGPT_EMP_NO")
        or load_credential("posco_gpt", "emp_no")
    )


def resolve_posco_comp_no() -> str:
    """Resolve the P-GPT company number from env or stored credentials."""
    return (
        os.environ.get("POSCO_COMP_NO")
        or os.environ.get("PGPT_COMP_NO")
        or load_credential("posco_gpt", "comp_no")
        or "30"
    )


def _message_content_as_text(message: ConversationMessage) -> str:
    parts: list[str] = []
    for block in message.content:
        if isinstance(block, TextBlock):
            parts.append(block.text)
        elif isinstance(block, ImageBlock):
            source = f" from {block.source_path}" if block.source_path else ""
            parts.append(f"[image attachment omitted{source}]")
        elif isinstance(block, ToolUseBlock):
            payload = {"id": block.id, "name": block.name, "input": block.input}
            parts.append("Tool call requested:\n" + json.dumps(payload, ensure_ascii=False))
        elif isinstance(block, ToolResultBlock):
            prefix = f"Tool result for {block.tool_use_id}"
            if block.is_error:
                prefix += " (error)"
            parts.append(f"{prefix}:\n{block.content}")
    return "\n\n".join(part for part in parts if part)


def _message_content_for_posco(message: ConversationMessage) -> str | list[dict[str, Any]]:
    """Convert one message content field to P-GPT's text/image format."""
    has_image = any(isinstance(block, ImageBlock) for block in message.content)
    if not has_image:
        return _message_content_as_text(message)

    content: list[dict[str, Any]] = []
    extra_text: list[str] = []
    for block in message.content:
        if isinstance(block, TextBlock) and block.text:
            content.append({"type": "text", "text": block.text})
        elif isinstance(block, ImageBlock):
            content.append(
                {
                    "type": "image_url",
                    "image_url": {
                        "url": f"data:{block.media_type};base64,{block.data}",
                    },
                }
            )
        elif isinstance(block, ToolUseBlock):
            payload = {"id": block.id, "name": block.name, "input": block.input}
            extra_text.append("Tool call requested:\n" + json.dumps(payload, ensure_ascii=False))
        elif isinstance(block, ToolResultBlock):
            prefix = f"Tool result for {block.tool_use_id}"
            if block.is_error:
                prefix += " (error)"
            extra_text.append(f"{prefix}:\n{block.content}")

    if extra_text:
        content.append({"type": "text", "text": "\n\n".join(extra_text)})
    return content


def convert_messages_to_posco(
    messages: list[ConversationMessage],
    system_prompt: str | None = None,
    tools: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Convert OpenHarness messages to P-GPT's chat payload."""
    result: list[dict[str, Any]] = []
    system_parts: list[str] = []
    if system_prompt:
        system_parts.append(system_prompt)
    if tools:
        system_parts.append(_tool_instruction(tools))
    if system_parts:
        result.append({"role": "system", "content": "\n\n".join(system_parts)})

    for message in messages:
        content = _message_content_for_posco(message)
        if content:
            result.append({"role": message.role, "content": content})
    return result


def build_posco_tool_response_format(tools: list[dict[str, Any]]) -> dict[str, Any]:
    """Build the JSON Schema response_format used for pseudo tool calling."""
    tool_names = [str(tool.get("name", "")) for tool in tools if tool.get("name")]
    return {
        "type": "json_schema",
        "json_schema": {
            "name": "openharness_tool_response",
            "strict": True,
            "schema": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": ["message", "tool_calls"]},
                    "content": {"type": "string"},
                    "calls": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "id": {"type": "string"},
                                "name": {"type": "string", "enum": tool_names},
                                "input": {
                                    "type": "object",
                                    "additionalProperties": True,
                                },
                            },
                            "required": ["id", "name", "input"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["type", "content", "calls"],
                "additionalProperties": False,
            },
        },
    }


def _tool_instruction(tools: list[dict[str, Any]]) -> str:
    tool_docs = [
        {
            "name": tool.get("name", ""),
            "description": tool.get("description", ""),
            "input_schema": tool.get("input_schema", {}),
        }
        for tool in tools
    ]
    return (
        "You may call tools by returning JSON that exactly matches the supplied "
        "response schema. Use type='message' for a final answer and "
        "type='tool_calls' when a tool is needed. Available tools:\n"
        + json.dumps(tool_docs, ensure_ascii=False)
    )


def extract_posco_payload(raw: Any) -> Any:
    """Extract P-GPT content from common response envelopes."""
    if isinstance(raw, str):
        return _loads_json_or_text(raw)
    if not isinstance(raw, dict):
        return raw
    if raw.get("type") in {"message", "tool_calls"}:
        return raw

    choices = raw.get("choices")
    if isinstance(choices, list) and choices:
        choice = choices[0]
        if isinstance(choice, dict):
            message = choice.get("message")
            if isinstance(message, dict) and "content" in message:
                return _loads_json_or_text(message.get("content"))
            if "text" in choice:
                return _loads_json_or_text(choice.get("text"))

    for key in ("content", "message", "text", "answer", "output", "response"):
        if key in raw:
            value = raw[key]
            if isinstance(value, dict) and "content" in value:
                return _loads_json_or_text(value["content"])
            return _loads_json_or_text(value)

    return raw


def parse_posco_assistant_message(payload: Any, *, tools_expected: bool = False) -> ConversationMessage:
    """Convert a P-GPT payload into an OpenHarness assistant message."""
    if isinstance(payload, str):
        parsed = _loads_json_or_text(payload) if tools_expected else payload
        if isinstance(parsed, str):
            return ConversationMessage(role="assistant", content=[TextBlock(text=parsed)])
        payload = parsed

    if not isinstance(payload, dict):
        return ConversationMessage(
            role="assistant",
            content=[TextBlock(text=json.dumps(payload, ensure_ascii=False))],
        )

    payload_type = payload.get("type")
    if payload_type == "tool_calls":
        blocks = []
        content = str(payload.get("content") or "")
        if content:
            blocks.append(TextBlock(text=content))
        calls = payload.get("calls") or []
        if isinstance(calls, list):
            for call in calls:
                if not isinstance(call, dict):
                    continue
                name = str(call.get("name") or "").strip()
                if not name:
                    continue
                call_id = str(call.get("id") or f"toolu_{uuid4().hex}")
                raw_input = call.get("input") if isinstance(call.get("input"), dict) else {}
                blocks.append(ToolUseBlock(id=call_id, name=name, input=raw_input))
        return ConversationMessage(role="assistant", content=blocks)

    content = payload.get("content")
    if content is None:
        content = json.dumps(payload, ensure_ascii=False)
    return ConversationMessage(role="assistant", content=[TextBlock(text=str(content))])


def _loads_json_or_text(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    stripped = value.strip()
    if not stripped:
        return ""
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return value


class PoscoGptClient:
    """Client for POSCO P-GPT's non-streaming JSON chat endpoint."""

    def __init__(
        self,
        api_key: str,
        *,
        emp_no: str | None = None,
        comp_no: str | None = None,
        base_url: str | None = None,
        timeout: float | None = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._api_key = api_key
        self._emp_no = emp_no or resolve_posco_emp_no()
        self._comp_no = comp_no or resolve_posco_comp_no()
        self._base_url = base_url or DEFAULT_POSCO_GPT_BASE_URL
        self._own_client = http_client is None
        self._client = http_client or httpx.AsyncClient(timeout=timeout or 60.0)

    async def stream_message(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        if not self._emp_no:
            raise AuthenticationFailure(
                "P-GPT requires empNo. Set POSCO_EMP_NO or run `/login API_KEY EMP_NO [COMP_NO]`."
            )

        body: dict[str, Any] = {
            "messages": convert_messages_to_posco(
                request.messages,
                request.system_prompt,
                request.tools,
            ),
            "model": request.model or DEFAULT_POSCO_GPT_MODEL,
            "need_origin": True,
        }
        if request.tools:
            body["response_format"] = build_posco_tool_response_format(request.tools)

        headers = {
            "Authorization": f"Bearer {build_posco_auth_token(self._api_key, self._emp_no, self._comp_no)}",
            "Content-Type": "application/json",
        }

        try:
            response = await self._client.post(self._base_url, headers=headers, json=body)
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code in {401, 403}:
                raise AuthenticationFailure(str(exc)) from exc
            raise RequestFailure(str(exc)) from exc
        except httpx.HTTPError as exc:
            raise RequestFailure(str(exc)) from exc

        payload = extract_posco_payload(response.json())
        message = parse_posco_assistant_message(payload, tools_expected=bool(request.tools))
        if message.text:
            yield ApiTextDeltaEvent(text=message.text)
        yield ApiMessageCompleteEvent(
            message=message,
            usage=UsageSnapshot(),
            stop_reason=None,
        )

    async def aclose(self) -> None:
        if self._own_client:
            await self._client.aclose()
