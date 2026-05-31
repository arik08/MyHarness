"""OpenAI Codex subscription client backed by chatgpt.com Codex Responses."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import platform
from typing import Any, AsyncIterator

import httpx

from myharness.api.client import (
    ApiMessageCompleteEvent,
    ApiMessageRequest,
    ApiRetryEvent,
    ApiStreamEvent,
    ApiTextDeltaEvent,
    ApiToolCallDeltaEvent,
)
from myharness.api.errors import AuthenticationFailure, MyHarnessApiError, RateLimitFailure, RequestFailure
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import (
    ConversationMessage,
    ImageBlock,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    sanitize_conversation_messages,
)

DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api"
JWT_CLAIM_PATH = "https://api.openai.com/auth"
MAX_RETRIES = 3
BASE_DELAY_SECONDS = 1.0
MAX_DELAY_SECONDS = 30.0
DEFAULT_CODEX_TIMEOUT_SECONDS = 180.0
CODEX_REASONING_EFFORTS = {"low", "medium", "high", "xhigh"}
_PROMPT_CACHE_RETENTION_VALUES = {"in_memory", "24h"}
_CACHE_OPTION_KEYS = ("prompt_cache_key", "prompt_cache_retention")
_UNSUPPORTED_OPTION_TERMS = (
    "unsupported",
    "unrecognized",
    "unknown",
    "invalid",
    "unexpected",
    "extra inputs",
    "not permitted",
)


def _normalize_reasoning_effort(effort: str | None) -> str | None:
    normalized = (effort or "").strip().lower()
    if normalized in {"", "none", "auto"}:
        return None
    if normalized == "max":
        normalized = "xhigh"
    if normalized in CODEX_REASONING_EFFORTS:
        return normalized
    return None


def _extract_account_id(token: str) -> str:
    parts = token.split(".")
    if len(parts) != 3:
        raise AuthenticationFailure("Codex access token is not a valid JWT.")
    try:
        payload = json.loads(
            base64.urlsafe_b64decode(parts[1] + "=" * (-len(parts[1]) % 4)).decode("utf-8")
        )
    except Exception as exc:
        raise AuthenticationFailure("Could not decode Codex access token payload.") from exc
    auth_claim = payload.get(JWT_CLAIM_PATH)
    if not isinstance(auth_claim, dict):
        raise AuthenticationFailure("Codex access token is missing account metadata.")
    account_id = auth_claim.get("chatgpt_account_id")
    if not isinstance(account_id, str) or not account_id:
        raise AuthenticationFailure("Codex access token is missing chatgpt_account_id.")
    return account_id


def _resolve_codex_url(base_url: str | None) -> str:
    trimmed = (base_url or "").strip()
    if trimmed and "chatgpt.com/backend-api" not in trimmed:
        trimmed = ""
    raw = (trimmed or DEFAULT_CODEX_BASE_URL).rstrip("/")
    if raw.endswith("/codex/responses"):
        return raw
    if raw.endswith("/codex"):
        return f"{raw}/responses"
    return f"{raw}/codex/responses"


def _prompt_cache_retention_from_env() -> str | None:
    raw_value = os.environ.get("MYHARNESS_CODEX_PROMPT_CACHE_RETENTION")
    if raw_value is None:
        return None
    value = raw_value.strip()
    if value in _PROMPT_CACHE_RETENTION_VALUES:
        return value
    return None


def _codex_cache_session_id(prompt_cache_key: str | None) -> str | None:
    if not prompt_cache_key:
        return None
    digest = hashlib.sha256(prompt_cache_key.encode("utf-8")).hexdigest()[:24]
    return f"myharness-cache-{digest}"


def _build_codex_headers(token: str, *, prompt_cache_key: str | None = None) -> dict[str, str]:
    account_id = _extract_account_id(token)
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id,
        "originator": "myharness",
        "User-Agent": f"myharness ({platform.system().lower()} {platform.machine() or 'unknown'})",
        "OpenAI-Beta": "responses=experimental",
        "accept": "text/event-stream",
        "content-type": "application/json",
    }
    cache_session_id = _codex_cache_session_id(prompt_cache_key)
    if cache_session_id:
        headers["session_id"] = cache_session_id
    return headers


def _convert_messages_to_codex(
    messages: list[ConversationMessage],
    *,
    developer_instructions: str | None = None,
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    if developer_instructions and developer_instructions.strip():
        result.append({
            "role": "developer",
            "content": [{"type": "input_text", "text": developer_instructions.strip()}],
        })
    for msg in messages:
        if msg.role == "user":
            user_content: list[dict[str, Any]] = []
            for block in msg.content:
                if isinstance(block, TextBlock) and block.text.strip():
                    user_content.append({"type": "input_text", "text": block.text})
                elif isinstance(block, ImageBlock):
                    user_content.append({
                        "type": "input_image",
                        "image_url": f"data:{block.media_type};base64,{block.data}",
                    })
            if user_content:
                result.append({"role": "user", "content": user_content})
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    result.append({
                        "type": "function_call_output",
                        "call_id": block.tool_use_id,
                        "output": block.content,
                    })
            continue

        assistant_text = "".join(block.text for block in msg.content if isinstance(block, TextBlock))
        if assistant_text:
            result.append({
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": assistant_text, "annotations": []}],
            })
        for block in msg.content:
            if isinstance(block, ToolUseBlock):
                result.append({
                    "type": "function_call",
                    "id": f"fc_{block.id[:58]}",
                    "call_id": block.id,
                    "name": block.name,
                    "arguments": json.dumps(block.input, separators=(",", ":")),
                })
    return result


def _prompt_cache_key_for_request(request: ApiMessageRequest) -> str:
    payload = {
        "model": request.model,
        "system_prompt": request.system_prompt or "You are MyHarness.",
        "tools": sorted(
            [
                {
                    "name": tool.get("name", ""),
                    "description": tool.get("description", ""),
                    "input_schema": tool.get("input_schema", {}),
                }
                for tool in request.tools
            ],
            key=lambda item: str(item.get("name", "")),
        ),
    }
    raw = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    digest = hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]
    return f"myharness:{digest}"


def _convert_tools_to_codex(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {
            "type": "function",
            "name": tool["name"],
            "description": tool.get("description", ""),
            "parameters": tool.get("input_schema", {}),
        }
        for tool in sorted(tools, key=lambda item: str(item.get("name", "")))
    ]


def _usage_from_response(response: dict[str, Any]) -> UsageSnapshot:
    usage = response.get("usage")
    if not isinstance(usage, dict):
        return UsageSnapshot()
    input_details = usage.get("input_tokens_details") if isinstance(usage.get("input_tokens_details"), dict) else {}
    return UsageSnapshot(
        input_tokens=int(usage.get("input_tokens") or 0),
        output_tokens=int(usage.get("output_tokens") or 0),
        cached_input_tokens=int(input_details.get("cached_tokens") or 0),
    )


def _stop_reason_from_response(response: dict[str, Any], *, has_tool_calls: bool) -> str | None:
    status = response.get("status")
    if has_tool_calls and status == "completed":
        return "tool_use"
    if status == "completed":
        return "stop"
    if status == "incomplete":
        return "length"
    if status in {"failed", "cancelled"}:
        return "error"
    return None


def _format_error_message(status_code: int, payload: str) -> str:
    try:
        parsed = json.loads(payload)
    except json.JSONDecodeError:
        parsed = None
    if isinstance(parsed, dict):
        error = parsed.get("error")
        if isinstance(error, dict):
            message = error.get("message")
            if isinstance(message, str) and message.strip():
                return message
        detail = parsed.get("detail")
        if isinstance(detail, str) and detail.strip():
            return detail
    text = payload.strip()
    if text:
        return text
    return f"Codex request failed with status {status_code}"


def _format_codex_stream_error(event: dict[str, Any], *, fallback: str) -> str:
    error = event.get("error")
    payload = error if isinstance(error, dict) else event
    message = payload.get("message") if isinstance(payload, dict) else None
    code = payload.get("code") if isinstance(payload, dict) else None
    request_id = (
        (payload.get("request_id") if isinstance(payload, dict) else None)
        or event.get("request_id")
    )

    parts: list[str] = []
    if isinstance(message, str) and message.strip():
        parts.append(message.strip())
    elif isinstance(code, str) and code.strip():
        parts.append(code.strip())
    else:
        parts.append(fallback)

    if isinstance(code, str) and code.strip():
        parts.append(f"(code={code.strip()})")
    if isinstance(request_id, str) and request_id.strip():
        parts.append(f"[request_id={request_id.strip()}]")
    return " ".join(parts)


def _translate_status_error(status_code: int, message: str) -> MyHarnessApiError:
    if status_code in {401, 403}:
        return AuthenticationFailure(message)
    if status_code == 429:
        return RateLimitFailure(message)
    return RequestFailure(message)


class CodexApiClient:
    """Client for ChatGPT/Codex subscription-backed Codex Responses."""

    def __init__(
        self,
        auth_token: str,
        *,
        base_url: str | None = None,
        timeout: float = DEFAULT_CODEX_TIMEOUT_SECONDS,
        prompt_cache_retention: str | None = None,
    ) -> None:
        self._auth_token = auth_token
        self._base_url = base_url
        self._url = _resolve_codex_url(base_url)
        self._timeout = timeout
        retention = prompt_cache_retention if prompt_cache_retention is not None else _prompt_cache_retention_from_env()
        self._prompt_cache_retention = retention if retention in _PROMPT_CACHE_RETENTION_VALUES else None
        self._unsupported_cache_option_names: set[str] = set()

    async def stream_message(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        last_error: Exception | None = None
        for attempt in range(MAX_RETRIES + 1):
            try:
                async for event in self._stream_once(request):
                    yield event
                return
            except Exception as exc:
                last_error = exc
                if attempt >= MAX_RETRIES or not self._is_retryable(exc):
                    raise self._translate_error(exc) from exc
                delay = min(BASE_DELAY_SECONDS * (2 ** attempt), MAX_DELAY_SECONDS)
                import asyncio

                yield ApiRetryEvent(
                    message=str(exc),
                    attempt=attempt + 1,
                    max_attempts=MAX_RETRIES + 1,
                    delay_seconds=delay,
                )
                await asyncio.sleep(delay)
        if last_error is not None:
            raise self._translate_error(last_error) from last_error

    def _request_body(self, request: ApiMessageRequest, safe_messages: list[ConversationMessage]) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": request.model,
            "store": False,
            "stream": True,
            "instructions": "You are MyHarness.",
            "text": {"verbosity": "medium"},
            "include": ["reasoning.encrypted_content"],
        }
        if "prompt_cache_key" not in self._unsupported_cache_option_names:
            body["prompt_cache_key"] = _prompt_cache_key_for_request(request)
        if (
            self._prompt_cache_retention
            and "prompt_cache_retention" not in self._unsupported_cache_option_names
            and "prompt_cache_key" in body
        ):
            body["prompt_cache_retention"] = self._prompt_cache_retention
        reasoning_effort = _normalize_reasoning_effort(request.reasoning_effort)
        if reasoning_effort:
            body["reasoning"] = {"effort": reasoning_effort}
        if request.tools:
            body["tools"] = _convert_tools_to_codex(request.tools)
            body["tool_choice"] = "auto"
            body["parallel_tool_calls"] = True
        body["input"] = _convert_messages_to_codex(
            safe_messages,
            developer_instructions=request.system_prompt or "You are MyHarness.",
        )
        return body

    async def _stream_once(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        safe_messages = sanitize_conversation_messages(request.messages)
        body = self._request_body(request, safe_messages)

        content: list[TextBlock | ToolUseBlock] = []
        current_text_parts: list[str] = []
        completed_response: dict[str, Any] | None = None
        tool_names_by_item_id: dict[str, str] = {}
        current_tool_name: str | None = None

        headers = _build_codex_headers(
            self._auth_token,
            prompt_cache_key=body.get("prompt_cache_key") if isinstance(body.get("prompt_cache_key"), str) else None,
        )
        timeout = httpx.Timeout(
            self._timeout,
            connect=min(self._timeout, 30.0),
            write=min(self._timeout, 60.0),
            pool=30.0,
        )
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            for option_attempt in range(2):
                async with client.stream("POST", self._url, headers=headers, json=body) as response:
                    if response.status_code >= 400:
                        payload = await response.aread()
                        message = _format_error_message(response.status_code, payload.decode("utf-8", "replace"))
                        if option_attempt == 0 and self._disable_unsupported_cache_options(message, body):
                            body = self._request_body(request, safe_messages)
                            continue
                        raise httpx.HTTPStatusError(message, request=response.request, response=response)

                    async for event in self._iter_sse_events(response):
                        event_type = event.get("type")
                        if event_type == "response.output_text.delta":
                            delta = event.get("delta")
                            if isinstance(delta, str) and delta:
                                current_text_parts.append(delta)
                                yield ApiTextDeltaEvent(text=delta)
                        elif event_type == "response.output_item.added":
                            item = event.get("item")
                            if not isinstance(item, dict) or item.get("type") != "function_call":
                                continue
                            name = item.get("name")
                            item_id = item.get("id")
                            if isinstance(name, str) and name:
                                current_tool_name = name
                                if isinstance(item_id, str) and item_id:
                                    tool_names_by_item_id[item_id] = name
                        elif event_type == "response.function_call_arguments.delta":
                            delta = event.get("delta")
                            if isinstance(delta, str) and delta:
                                item_id = event.get("item_id")
                                name = (
                                    tool_names_by_item_id.get(item_id)
                                    if isinstance(item_id, str)
                                    else current_tool_name
                                )
                                index = event.get("output_index")
                                yield ApiToolCallDeltaEvent(
                                    index=index if isinstance(index, int) else 0,
                                    name=name,
                                    arguments_delta=delta,
                                )
                        elif event_type == "response.output_item.done":
                            item = event.get("item")
                            if not isinstance(item, dict):
                                continue
                            item_type = item.get("type")
                            if item_type == "message":
                                text = ""
                                raw_content = item.get("content")
                                if isinstance(raw_content, list):
                                    parts = []
                                    for block in raw_content:
                                        if isinstance(block, dict):
                                            if block.get("type") == "output_text":
                                                parts.append(str(block.get("text", "")))
                                            elif block.get("type") == "refusal":
                                                parts.append(str(block.get("refusal", "")))
                                    text = "".join(parts)
                                if text:
                                    content.append(TextBlock(text=text))
                            elif item_type == "function_call":
                                arguments = item.get("arguments")
                                parsed_arguments: dict[str, Any]
                                if isinstance(arguments, str) and arguments:
                                    try:
                                        loaded = json.loads(arguments)
                                    except json.JSONDecodeError:
                                        loaded = {}
                                else:
                                    loaded = {}
                                parsed_arguments = loaded if isinstance(loaded, dict) else {}
                                call_id = item.get("call_id")
                                name = item.get("name")
                                if isinstance(call_id, str) and call_id and isinstance(name, str) and name:
                                    content.append(ToolUseBlock(id=call_id, name=name, input=parsed_arguments))
                        elif event_type == "response.completed":
                            response_payload = event.get("response")
                            if isinstance(response_payload, dict):
                                completed_response = response_payload
                        elif event_type == "response.failed":
                            response_payload = event.get("response")
                            if isinstance(response_payload, dict):
                                raise RequestFailure(
                                    _format_codex_stream_error(
                                        response_payload,
                                        fallback="Codex response failed",
                                    )
                                )
                            raise RequestFailure("Codex response failed")
                        elif event_type == "error":
                            raise RequestFailure(
                                _format_codex_stream_error(event, fallback="Codex error")
                            )
                    break

        if current_text_parts and not any(isinstance(block, TextBlock) for block in content):
            content.insert(0, TextBlock(text="".join(current_text_parts)))

        final_message = ConversationMessage(role="assistant", content=content)
        usage = _usage_from_response(completed_response or {})
        stop_reason = _stop_reason_from_response(
            completed_response or {},
            has_tool_calls=bool(final_message.tool_uses),
        )
        yield ApiMessageCompleteEvent(
            message=final_message,
            usage=usage,
            stop_reason=stop_reason,
        )

    async def _iter_sse_events(self, response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
        data_lines: list[str] = []
        async for line in response.aiter_lines():
            if line == "":
                if data_lines:
                    payload = "\n".join(data_lines).strip()
                    data_lines = []
                    if payload and payload != "[DONE]":
                        try:
                            event = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if isinstance(event, dict):
                            yield event
                continue
            if line.startswith("data:"):
                data_lines.append(line[5:].strip())
        if data_lines:
            payload = "\n".join(data_lines).strip()
            if payload and payload != "[DONE]":
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    return
                if isinstance(event, dict):
                    yield event

    def _disable_unsupported_cache_options(self, message: str, body: dict[str, Any]) -> bool:
        text = message.lower()
        if not any(term in text for term in _UNSUPPORTED_OPTION_TERMS):
            return False
        disabled: set[str] = set()
        for key in _CACHE_OPTION_KEYS:
            if key in body and key.lower() in text:
                disabled.add(key)
        if not disabled and "cache" in text and "prompt_cache_retention" in body:
            disabled.add("prompt_cache_retention")
        if not disabled:
            return False
        self._unsupported_cache_option_names.update(disabled)
        return True

    @staticmethod
    def _is_retryable(exc: Exception) -> bool:
        if isinstance(exc, httpx.HTTPStatusError):
            return exc.response.status_code in {429, 500, 502, 503, 504}
        if isinstance(exc, RateLimitFailure):
            return True
        if isinstance(exc, RequestFailure):
            message = str(exc).lower()
            return any(term in message for term in ["timeout", "connect", "network", "rate", "overloaded"])
        if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
            return True
        return False

    @staticmethod
    def _translate_error(exc: Exception) -> MyHarnessApiError:
        if isinstance(exc, MyHarnessApiError):
            return exc
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            return _translate_status_error(status, str(exc))
        if isinstance(exc, httpx.HTTPError):
            return RequestFailure(str(exc))
        return RequestFailure(str(exc))
