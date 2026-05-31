"""OpenAI-compatible API client for providers like Alibaba DashScope, GitHub Models, etc."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import time
from typing import Any, AsyncIterator
from urllib.parse import urlsplit, urlunsplit

import httpx
from openai import AsyncOpenAI

from myharness.api.client import (
    ApiMessageCompleteEvent,
    ApiMessageRequest,
    ApiRetryEvent,
    ApiStreamEvent,
    ApiTextDeltaEvent,
    ApiToolCallDeltaEvent,
)
from myharness.api.errors import (
    AuthenticationFailure,
    MyHarnessApiError,
    RateLimitFailure,
    RequestFailure,
)
from myharness.api.usage import UsageSnapshot
from myharness.config.paths import get_logs_dir
from myharness.engine.messages import (
    ConversationMessage,
    ContentBlock,
    ImageBlock,
    TextBlock,
    ToolResultBlock,
    ToolUseBlock,
    sanitize_conversation_messages,
)

log = logging.getLogger(__name__)

MAX_RETRIES = 3
BASE_DELAY = 1.0
MAX_DELAY = 30.0
_MAX_COMPLETION_TOKEN_MODEL_PREFIXES = ("gpt-5", "o1", "o3", "o4")
_CACHE_OPTION_KEYS = ("prompt_cache_key", "prompt_cache_retention", "stream_options")
_PROMPT_CACHE_RETENTION_VALUES = {"in_memory", "24h"}
_CACHE_EVENT_REASONS = {
    "system_prompt_changed",
    "tool_schema_changed",
    "compaction_rewrite",
    "provider_settings_changed",
    "session_restore",
    "unknown",
}
_UNSUPPORTED_OPTION_TERMS = (
    "unsupported",
    "unrecognized",
    "unknown",
    "invalid",
    "unexpected",
    "extra inputs",
    "not permitted",
)


def _token_limit_param_for_model(model: str, max_tokens: int) -> dict[str, int]:
    """Return the correct token limit field for the target OpenAI model.

    GPT-5 and the current reasoning-model families reject ``max_tokens`` and
    require ``max_completion_tokens`` instead.
    """
    normalized = model.strip().lower()
    if "/" in normalized:
        normalized = normalized.rsplit("/", 1)[-1]
    if normalized.startswith(_MAX_COMPLETION_TOKEN_MODEL_PREFIXES):
        return {"max_completion_tokens": max_tokens}
    return {"max_tokens": max_tokens}


def _stable_json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _stable_hash(value: Any, *, length: int = 32) -> str:
    payload = value if isinstance(value, str) else _stable_json(value)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()[:length]


def _stable_tool_schema_payload(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        [
            {
                "name": str(tool.get("name") or ""),
                "description": str(tool.get("description") or ""),
                "input_schema": tool.get("input_schema") or {},
            }
            for tool in tools
        ],
        key=lambda item: item["name"],
    )


def _prompt_cache_key_for_request(request: ApiMessageRequest) -> str:
    """Build a stable routing key without embedding raw prompt text."""
    payload = {
        "model": str(request.model or "").strip().lower(),
        "system_prompt_hash": _stable_hash(request.system_prompt or ""),
        "tool_schema_hash": _stable_hash(_stable_tool_schema_payload(request.tools)),
    }
    return f"myharness:{_stable_hash(payload)}"


def _prompt_cache_retention_from_env() -> str | None:
    raw_value = os.environ.get("MYHARNESS_PROMPT_CACHE_RETENTION")
    if raw_value is None:
        return "24h"
    value = raw_value.strip()
    if value in _PROMPT_CACHE_RETENTION_VALUES:
        return value
    if value:
        log.warning(
            "Ignoring unsupported MYHARNESS_PROMPT_CACHE_RETENTION=%r; allowed values are %s",
            value,
            ", ".join(sorted(_PROMPT_CACHE_RETENTION_VALUES)),
        )
    return None


def _message_content_length(message: dict[str, Any]) -> int:
    content = message.get("content")
    if isinstance(content, str):
        return len(content)
    if isinstance(content, list):
        total = 0
        for item in content:
            if isinstance(item, dict):
                total += len(str(item.get("text") or ""))
                image_url = item.get("image_url")
                if isinstance(image_url, dict):
                    total += len(str(image_url.get("url") or ""))
        return total
    return 0


def _convert_tools_to_openai(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert Anthropic tool schemas to OpenAI function-calling format.

    Anthropic format:
        {"name": "...", "description": "...", "input_schema": {...}}
    OpenAI format:
        {"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}
    """
    result = []
    for tool in sorted(tools, key=lambda item: str(item.get("name") or "")):
        result.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": tool.get("input_schema", {}),
            },
        })
    return result


def _convert_messages_to_openai(
    messages: list[ConversationMessage],
    system_prompt: str | None,
) -> list[dict[str, Any]]:
    """Convert Anthropic-style messages to OpenAI chat format.

    Key differences:
    - Anthropic: system prompt is a separate parameter
    - OpenAI: system prompt is a message with role="system"
    - Anthropic: tool_use / tool_result are content blocks
    - OpenAI: tool_calls on assistant message, tool results are separate messages
    """
    openai_messages: list[dict[str, Any]] = []

    if system_prompt:
        openai_messages.append({"role": "system", "content": system_prompt})

    for msg in messages:
        if msg.role == "assistant":
            openai_msg = _convert_assistant_message(msg)
            openai_messages.append(openai_msg)
        elif msg.role == "user":
            # User messages may contain text or tool_result blocks
            tool_results = [b for b in msg.content if isinstance(b, ToolResultBlock)]
            user_blocks = [b for b in msg.content if isinstance(b, (TextBlock, ImageBlock))]

            if tool_results:
                # Each tool result becomes a separate message with role="tool"
                for tr in tool_results:
                    openai_messages.append({
                        "role": "tool",
                        "tool_call_id": tr.tool_use_id,
                        "content": tr.content,
                    })
            if user_blocks:
                content = _convert_user_content_to_openai(user_blocks)
                if isinstance(content, str):
                    if content.strip():
                        openai_messages.append({"role": "user", "content": content})
                elif content:
                    openai_messages.append({"role": "user", "content": content})
            if not tool_results and not user_blocks:
                # Empty user message (shouldn't happen, but handle gracefully)
                openai_messages.append({"role": "user", "content": ""})

    return openai_messages


def _convert_user_content_to_openai(blocks: list[ContentBlock]) -> str | list[dict[str, Any]]:
    """Convert user text/image blocks into OpenAI chat content."""
    has_image = any(isinstance(block, ImageBlock) for block in blocks)
    if not has_image:
        return "".join(block.text for block in blocks if isinstance(block, TextBlock))

    content: list[dict[str, Any]] = []
    for block in blocks:
        if isinstance(block, TextBlock) and block.text:
            content.append({"type": "text", "text": block.text})
        elif isinstance(block, ImageBlock):
            content.append({
                "type": "image_url",
                "image_url": {
                    "url": f"data:{block.media_type};base64,{block.data}",
                },
            })
    return content


def _convert_assistant_message(msg: ConversationMessage) -> dict[str, Any]:
    """Convert an assistant ConversationMessage to OpenAI format.

    Providers with thinking models (e.g. Kimi k2.5) require a
    ``reasoning_content`` field on every assistant message that contains
    tool calls.  We stash the raw reasoning text on ``msg._reasoning``
    during parsing and replay it here.
    """
    text_parts = [b.text for b in msg.content if isinstance(b, TextBlock)]
    tool_uses = [b for b in msg.content if isinstance(b, ToolUseBlock)]

    openai_msg: dict[str, Any] = {"role": "assistant"}

    content = "".join(text_parts)
    openai_msg["content"] = content if content else None

    # Replay reasoning_content for thinking models (stored by streaming parser)
    reasoning = getattr(msg, "_reasoning", None)
    if reasoning:
        openai_msg["reasoning_content"] = reasoning
    elif tool_uses:
        # Thinking models require this field even if empty
        openai_msg["reasoning_content"] = ""

    if tool_uses:
        openai_msg["tool_calls"] = [
            {
                "id": tu.id,
                "type": "function",
                "function": {
                    "name": tu.name,
                    "arguments": json.dumps(tu.input),
                },
            }
            for tu in tool_uses
        ]

    return openai_msg


def _parse_assistant_response(response: Any) -> ConversationMessage:
    """Parse an OpenAI ChatCompletion response into a ConversationMessage."""
    choice = response.choices[0]
    message = choice.message
    content: list[ContentBlock] = []

    if message.content:
        content.append(TextBlock(text=message.content))

    if message.tool_calls:
        for tc in message.tool_calls:
            try:
                args = json.loads(tc.function.arguments)
            except (json.JSONDecodeError, TypeError):
                args = {}
            content.append(ToolUseBlock(
                id=tc.id,
                name=tc.function.name,
                input=args,
            ))

    return ConversationMessage(role="assistant", content=content)


def _normalize_openai_base_url(base_url: str | None) -> str | None:
    """Normalize custom OpenAI-compatible base URLs without dropping API path segments."""
    if not base_url:
        return None
    trimmed = base_url.strip()
    if not trimmed:
        return None
    parts = urlsplit(trimmed)
    if not parts.scheme or not parts.netloc:
        return trimmed.rstrip("/")
    path = parts.path.rstrip("/")
    if not path:
        path = "/v1"
    return urlunsplit((parts.scheme, parts.netloc, path, parts.query, parts.fragment))


class OpenAICompatibleClient:
    """Client for OpenAI-compatible APIs (DashScope, GitHub Models, etc.).

    Implements the same SupportsStreamingMessages protocol as AnthropicApiClient
    so it can be used as a drop-in replacement in the agent loop.
    """

    def __init__(
        self,
        api_key: str,
        *,
        base_url: str | None = None,
        timeout: float | None = None,
        raw_stream: bool = False,
        diagnostics_label: str | None = None,
        enable_prompt_cache_options: bool = False,
        include_usage_with_tools: bool = False,
        prompt_cache_retention: str | None = None,
    ) -> None:
        self._api_key = api_key
        self._base_url = _normalize_openai_base_url(base_url)
        self._timeout = timeout
        self._raw_stream = raw_stream
        self._diagnostics_label = diagnostics_label or ""
        self._enable_prompt_cache_options = enable_prompt_cache_options
        self._include_usage_with_tools = include_usage_with_tools
        retention = prompt_cache_retention if prompt_cache_retention is not None else _prompt_cache_retention_from_env()
        self._prompt_cache_retention = retention if retention in _PROMPT_CACHE_RETENTION_VALUES else None
        self._unsupported_cache_option_names: set[str] = set()
        self._last_cache_diagnostic_snapshot: dict[str, Any] | None = None
        kwargs: dict[str, Any] = {"api_key": api_key}
        if self._base_url:
            kwargs["base_url"] = self._base_url
        if timeout is not None:
            kwargs["timeout"] = timeout
        self._client = AsyncOpenAI(**kwargs)

    async def stream_message(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        """Yield text deltas and the final message, matching the Anthropic client interface."""
        last_error: Exception | None = None

        for attempt in range(MAX_RETRIES + 1):
            try:
                stream_once = self._stream_raw_once if self._raw_stream else self._stream_once
                async for event in stream_once(request):
                    yield event
                return
            except MyHarnessApiError:
                raise
            except Exception as exc:
                last_error = exc
                if attempt >= MAX_RETRIES or not self._is_retryable(exc):
                    raise self._translate_error(exc) from exc

                delay = min(BASE_DELAY * (2 ** attempt), MAX_DELAY)
                log.warning(
                    "OpenAI API request failed (attempt %d/%d), retrying in %.1fs: %s",
                    attempt + 1, MAX_RETRIES + 1, delay, exc,
                )
                yield ApiRetryEvent(
                    message=str(exc),
                    attempt=attempt + 1,
                    max_attempts=MAX_RETRIES + 1,
                    delay_seconds=delay,
                )
                await asyncio.sleep(delay)

        if last_error is not None:
            raise self._translate_error(last_error) from last_error

    def _completion_params(self, request: ApiMessageRequest) -> dict[str, Any]:
        safe_messages = sanitize_conversation_messages(request.messages)
        openai_messages = _convert_messages_to_openai(safe_messages, request.system_prompt)
        openai_tools = _convert_tools_to_openai(request.tools) if request.tools else None

        params: dict[str, Any] = {
            "model": request.model,
            "stream": True,
        }
        if openai_tools:
            params["tools"] = openai_tools
        if (
            (not openai_tools or self._include_usage_with_tools)
            and "stream_options" not in self._unsupported_cache_option_names
        ):
            params["stream_options"] = {"include_usage": True}
        params.update(_token_limit_param_for_model(request.model, request.max_tokens))
        if self._enable_prompt_cache_options:
            if "prompt_cache_key" not in self._unsupported_cache_option_names:
                params["prompt_cache_key"] = _prompt_cache_key_for_request(request)
            if (
                self._prompt_cache_retention
                and "prompt_cache_retention" not in self._unsupported_cache_option_names
                and "prompt_cache_key" in params
            ):
                params["prompt_cache_retention"] = self._prompt_cache_retention
        params["messages"] = openai_messages
        if openai_tools and not self._include_usage_with_tools:
            # Some providers (Kimi) error on empty reasoning_content in
            # tool-call follow-ups.  Omit the entire stream_options key if
            # tools are present – avoids triggering model-side thinking mode
            # that requires reasoning_content on every assistant message.
            params.pop("stream_options", None)
        return params

    async def _stream_once(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        """Single attempt: stream an OpenAI chat completion."""
        params = self._completion_params(request)
        self._write_cache_diagnostic("request_start", request, params)

        # Collect full response while streaming text deltas
        collected_content = ""
        collected_reasoning = ""
        collected_tool_calls: dict[int, dict[str, Any]] = {}
        finish_reason: str | None = None
        usage_data: dict[str, int] = {}
        # Buffer to strip inline <think>…</think> blocks across streaming chunks.
        _think_buf = ""

        stream = await self._create_sdk_stream(request, params)
        async for chunk in stream:
            if not chunk.choices:
                # Usage-only chunk (some providers send this at the end)
                if chunk.usage:
                    usage_data = {
                        "input_tokens": chunk.usage.prompt_tokens or 0,
                        "output_tokens": chunk.usage.completion_tokens or 0,
                        "cached_input_tokens": self._cached_tokens_from_usage(chunk.usage),
                    }
                continue

            delta = chunk.choices[0].delta
            chunk_finish = chunk.choices[0].finish_reason

            if chunk_finish:
                finish_reason = chunk_finish

            # Accumulate reasoning_content from thinking models (not shown to user)
            reasoning_piece = getattr(delta, "reasoning_content", None) or ""
            if reasoning_piece:
                collected_reasoning += reasoning_piece

            # Stream text content to user, stripping inline <think> blocks
            if delta.content:
                _think_buf += delta.content
                visible, _think_buf = _strip_think_blocks(_think_buf)
                if visible:
                    collected_content += visible
                    yield ApiTextDeltaEvent(text=visible)

            # Accumulate tool calls
            if delta.tool_calls:
                for tc_delta in delta.tool_calls:
                    idx = tc_delta.index
                    if idx not in collected_tool_calls:
                        collected_tool_calls[idx] = {
                            "id": tc_delta.id or "",
                            "name": "",
                            "arguments": "",
                        }
                    entry = collected_tool_calls[idx]
                    if tc_delta.id:
                        entry["id"] = tc_delta.id
                    if tc_delta.function:
                        if tc_delta.function.name:
                            entry["name"] = tc_delta.function.name
                        if tc_delta.function.arguments:
                            entry["arguments"] += tc_delta.function.arguments
                            yield ApiToolCallDeltaEvent(
                                index=idx,
                                name=entry["name"] or None,
                                arguments_delta=tc_delta.function.arguments,
                            )

            # Usage in chunk (if provider sends it)
            if chunk.usage:
                usage_data = {
                    "input_tokens": chunk.usage.prompt_tokens or 0,
                    "output_tokens": chunk.usage.completion_tokens or 0,
                    "cached_input_tokens": self._cached_tokens_from_usage(chunk.usage),
                }

        # Build the final ConversationMessage
        content: list[ContentBlock] = []
        if collected_content:
            content.append(TextBlock(text=collected_content))

        for _idx in sorted(collected_tool_calls.keys()):
            tc = collected_tool_calls[_idx]
            # Skip phantom/empty tool calls that some providers send
            if not tc["name"]:
                continue
            try:
                args = json.loads(tc["arguments"])
            except (json.JSONDecodeError, TypeError):
                args = {}
            content.append(ToolUseBlock(
                id=tc["id"],
                name=tc["name"],
                input=args,
            ))

        final_message = ConversationMessage(role="assistant", content=content)

        # Stash reasoning for thinking models so _convert_assistant_message
        # can replay it when the message is sent back to the API
        if collected_reasoning:
            final_message._reasoning = collected_reasoning  # type: ignore[attr-defined]

        usage_snapshot = UsageSnapshot(
            input_tokens=usage_data.get("input_tokens", 0),
            output_tokens=usage_data.get("output_tokens", 0),
            cached_input_tokens=usage_data.get("cached_input_tokens", 0),
        )
        self._write_cache_diagnostic("message_complete", request, params, usage=usage_snapshot)
        yield ApiMessageCompleteEvent(
            message=final_message,
            usage=usage_snapshot,
            stop_reason=finish_reason,
        )

    async def _create_sdk_stream(self, request: ApiMessageRequest, params: dict[str, Any]) -> Any:
        try:
            return await self._client.chat.completions.create(**params)
        except Exception as exc:
            if not self._disable_unsupported_cache_options(str(exc), params):
                raise
            fallback_params = self._completion_params(request)
            self._write_cache_diagnostic("request_fallback", request, fallback_params)
            return await self._client.chat.completions.create(**fallback_params)

    async def _stream_raw_once(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        """Single attempt using a direct SSE reader for OpenAI-compatible providers."""
        params = self._completion_params(request)
        self._write_cache_diagnostic("request_start", request, params)
        collected_content = ""
        collected_reasoning = ""
        collected_tool_calls: dict[int, dict[str, Any]] = {}
        finish_reason: str | None = None
        usage_data: dict[str, int] = {}
        think_buf = ""
        started_at = time.monotonic()
        self._write_stream_diagnostic("request_start", model=request.model)

        timeout_seconds = self._timeout or 600.0
        timeout = httpx.Timeout(
            timeout_seconds,
            connect=min(timeout_seconds, 30.0),
            write=min(timeout_seconds, 60.0),
            pool=30.0,
        )
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
            for option_attempt in range(2):
                async with client.stream(
                    "POST",
                    self._chat_completions_url(),
                    headers=self._raw_stream_headers(),
                    json=params,
                ) as response:
                    if response.status_code >= 400:
                        payload = await response.aread()
                        message = payload.decode("utf-8", "replace") or f"HTTP {response.status_code}"
                        if option_attempt == 0 and self._disable_unsupported_cache_options(message, params):
                            params = self._completion_params(request)
                            self._write_cache_diagnostic("request_fallback", request, params)
                            continue
                        raise httpx.HTTPStatusError(message, request=response.request, response=response)

                    async for payload in self._iter_raw_sse_payloads(response):
                        self._capture_usage(payload, usage_data)
                        choices = payload.get("choices")
                        if not isinstance(choices, list) or not choices:
                            continue
                        for choice in choices:
                            if not isinstance(choice, dict):
                                continue
                            choice_finish = choice.get("finish_reason")
                            if isinstance(choice_finish, str) and choice_finish:
                                finish_reason = choice_finish
                            delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                            message = choice.get("message") if isinstance(choice.get("message"), dict) else {}

                            reasoning_piece = str(delta.get("reasoning_content") or "")
                            if reasoning_piece:
                                collected_reasoning += reasoning_piece
                                self._write_stream_diagnostic(
                                    "reasoning_delta",
                                    elapsed_ms=self._elapsed_ms(started_at),
                                    text_length=len(reasoning_piece),
                                )

                            content_piece = delta.get("content")
                            if isinstance(content_piece, str) and content_piece:
                                think_buf += content_piece
                                visible, think_buf = _strip_think_blocks(think_buf)
                                if visible:
                                    collected_content += visible
                                    self._write_stream_diagnostic(
                                        "text_delta",
                                        elapsed_ms=self._elapsed_ms(started_at),
                                        text_length=len(visible),
                                    )
                                    yield ApiTextDeltaEvent(text=visible)

                            if isinstance(message.get("content"), str) and message.get("content") and not collected_content:
                                collected_content = str(message["content"])

                            for tc_delta in self._iter_tool_call_dicts(delta.get("tool_calls")):
                                idx = tc_delta["index"]
                                entry = collected_tool_calls.setdefault(
                                    idx,
                                    {"id": "", "name": "", "arguments": ""},
                                )
                                if tc_delta["id"]:
                                    entry["id"] = tc_delta["id"]
                                if tc_delta["name"]:
                                    entry["name"] = tc_delta["name"]
                                if tc_delta["arguments"]:
                                    entry["arguments"] += tc_delta["arguments"]
                                    self._write_stream_diagnostic(
                                        "tool_delta",
                                        elapsed_ms=self._elapsed_ms(started_at),
                                        index=idx,
                                        tool_name=entry["name"],
                                        arguments_length=len(tc_delta["arguments"]),
                                    )
                                    yield ApiToolCallDeltaEvent(
                                        index=idx,
                                        name=entry["name"] or None,
                                        arguments_delta=tc_delta["arguments"],
                                    )

                            for tc_final in self._iter_tool_call_dicts(message.get("tool_calls")):
                                idx = tc_final["index"]
                                entry = collected_tool_calls.setdefault(
                                    idx,
                                    {"id": "", "name": "", "arguments": ""},
                                )
                                if tc_final["id"]:
                                    entry["id"] = tc_final["id"]
                                if tc_final["name"]:
                                    entry["name"] = tc_final["name"]
                                if tc_final["arguments"]:
                                    entry["arguments"] = tc_final["arguments"]
                                    self._write_stream_diagnostic(
                                        "tool_final",
                                        elapsed_ms=self._elapsed_ms(started_at),
                                        index=idx,
                                        tool_name=entry["name"],
                                        arguments_length=len(tc_final["arguments"]),
                                    )
                    break

        content: list[ContentBlock] = []
        if collected_content:
            content.append(TextBlock(text=collected_content))

        for idx in sorted(collected_tool_calls.keys()):
            tc = collected_tool_calls[idx]
            if not tc["name"]:
                continue
            try:
                args = json.loads(tc["arguments"])
            except (json.JSONDecodeError, TypeError):
                args = {}
            content.append(ToolUseBlock(id=tc["id"], name=tc["name"], input=args))

        final_message = ConversationMessage(role="assistant", content=content)
        if collected_reasoning:
            final_message._reasoning = collected_reasoning  # type: ignore[attr-defined]

        self._write_stream_diagnostic(
            "message_complete",
            elapsed_ms=self._elapsed_ms(started_at),
            text_length=len(collected_content),
            tool_calls=len(collected_tool_calls),
            finish_reason=finish_reason or "",
        )
        usage_snapshot = UsageSnapshot(
            input_tokens=usage_data.get("input_tokens", 0),
            output_tokens=usage_data.get("output_tokens", 0),
            cached_input_tokens=usage_data.get("cached_input_tokens", 0),
        )
        self._write_cache_diagnostic("message_complete", request, params, usage=usage_snapshot)
        yield ApiMessageCompleteEvent(
            message=final_message,
            usage=usage_snapshot,
            stop_reason=finish_reason,
        )

    def _chat_completions_url(self) -> str:
        base_url = (self._base_url or "https://api.openai.com/v1").rstrip("/")
        return f"{base_url}/chat/completions"

    def _raw_stream_headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
            "Accept": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }

    @staticmethod
    async def _iter_raw_sse_payloads(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
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
                continue
            stripped = line.strip()
            if stripped.startswith("{") and stripped.endswith("}"):
                try:
                    event = json.loads(stripped)
                except json.JSONDecodeError:
                    continue
                if isinstance(event, dict):
                    yield event
        if data_lines:
            payload = "\n".join(data_lines).strip()
            if payload and payload != "[DONE]":
                try:
                    event = json.loads(payload)
                except json.JSONDecodeError:
                    return
                if isinstance(event, dict):
                    yield event

    @staticmethod
    def _iter_tool_call_dicts(value: Any) -> list[dict[str, Any]]:
        if not isinstance(value, list):
            return []
        calls: list[dict[str, Any]] = []
        for position, item in enumerate(value):
            if not isinstance(item, dict):
                continue
            function = item.get("function") if isinstance(item.get("function"), dict) else {}
            raw_index = item.get("index", position)
            index = raw_index if isinstance(raw_index, int) else position
            calls.append(
                {
                    "index": index,
                    "id": str(item.get("id") or ""),
                    "name": str(function.get("name") or ""),
                    "arguments": str(function.get("arguments") or ""),
                }
            )
        return calls

    @staticmethod
    def _capture_usage(payload: dict[str, Any], usage_data: dict[str, int]) -> None:
        usage = payload.get("usage")
        if not isinstance(usage, dict):
            return
        usage_data.update(
            {
                "input_tokens": int(usage.get("prompt_tokens") or usage.get("input_tokens") or 0),
                "output_tokens": int(usage.get("completion_tokens") or usage.get("output_tokens") or 0),
                "cached_input_tokens": OpenAICompatibleClient._cached_tokens_from_usage(usage),
            }
        )

    @staticmethod
    def _cached_tokens_from_usage(usage: Any) -> int:
        for details_name in ("prompt_tokens_details", "input_tokens_details"):
            details = usage.get(details_name) if isinstance(usage, dict) else getattr(usage, details_name, None)
            if not details:
                continue
            value = details.get("cached_tokens") if isinstance(details, dict) else getattr(details, "cached_tokens", 0)
            try:
                cached_tokens = int(value or 0)
            except (TypeError, ValueError):
                cached_tokens = 0
            if cached_tokens > 0:
                return cached_tokens
        return 0

    @staticmethod
    def _elapsed_ms(started_at: float) -> int:
        return max(0, round((time.monotonic() - started_at) * 1000))

    def _write_stream_diagnostic(self, event: str, **fields: Any) -> None:
        if not self._raw_stream:
            return
        try:
            payload = {
                "ts": time.time(),
                "provider": self._diagnostics_label or "openai-compatible",
                "event": event,
                **fields,
            }
            path = get_logs_dir() / "provider-stream-diagnostics.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
        except Exception:
            log.debug("failed to write provider stream diagnostic", exc_info=True)

    def _disable_unsupported_cache_options(self, message: str, params: dict[str, Any]) -> bool:
        text = message.lower()
        if not any(term in text for term in _UNSUPPORTED_OPTION_TERMS):
            return False
        disabled: set[str] = set()
        for key in _CACHE_OPTION_KEYS:
            if key in params and key.lower() in text:
                disabled.add(key)
        if "include_usage" in text and "stream_options" in params:
            disabled.add("stream_options")
        if not disabled and "cache" in text:
            if "prompt_cache_key" in params:
                disabled.add("prompt_cache_key")
            if "prompt_cache_retention" in params:
                disabled.add("prompt_cache_retention")
        if not disabled:
            return False
        self._unsupported_cache_option_names.update(disabled)
        self._write_cache_diagnostic(
            "options_disabled",
            None,
            params,
            disabled_options=sorted(disabled),
            error_class="unsupported_parameter",
        )
        return True

    def _cache_diagnostic_snapshot(self, request: ApiMessageRequest, params: dict[str, Any]) -> dict[str, Any]:
        messages = params.get("messages") if isinstance(params.get("messages"), list) else []
        tools = params.get("tools") if isinstance(params.get("tools"), list) else []
        message_roles = [str(item.get("role") or "") for item in messages if isinstance(item, dict)]
        message_prefix = messages[:-1] if messages else []
        provider_settings = {
            "model": params.get("model"),
            "base_url": self._base_url or "https://api.openai.com/v1",
            "has_prompt_cache_key": "prompt_cache_key" in params,
            "prompt_cache_retention": params.get("prompt_cache_retention") or "",
            "include_usage": bool(params.get("stream_options", {}).get("include_usage"))
            if isinstance(params.get("stream_options"), dict)
            else False,
            "unsupported_options": sorted(self._unsupported_cache_option_names),
        }
        system_prompt = request.system_prompt or ""
        snapshot = {
            "model": str(request.model or ""),
            "cache_event": request.cache_event or "",
            "prompt_cache_key": params.get("prompt_cache_key") or "",
            "prompt_cache_retention": params.get("prompt_cache_retention") or "",
            "system_prompt_hash": _stable_hash(system_prompt),
            "system_prompt_chars": len(system_prompt),
            "tool_schema_hash": _stable_hash(_stable_tool_schema_payload(request.tools)),
            "tool_count": len(tools),
            "message_prefix_hash": _stable_hash(message_prefix),
            "message_count": len(messages),
            "message_roles": message_roles,
            "message_content_chars": sum(_message_content_length(item) for item in messages if isinstance(item, dict)),
            "provider_settings_hash": _stable_hash(provider_settings),
            "unsupported_cache_options": sorted(self._unsupported_cache_option_names),
        }
        snapshot["prefix_change_reason"] = self._infer_prefix_change_reason(snapshot)
        self._last_cache_diagnostic_snapshot = snapshot
        return snapshot

    def _infer_prefix_change_reason(self, snapshot: dict[str, Any]) -> str:
        cache_event = str(snapshot.get("cache_event") or "")
        if cache_event in _CACHE_EVENT_REASONS:
            return cache_event
        previous = self._last_cache_diagnostic_snapshot
        if previous is None:
            return "first_request"
        if snapshot.get("provider_settings_hash") != previous.get("provider_settings_hash"):
            return "provider_settings_changed"
        if snapshot.get("system_prompt_hash") != previous.get("system_prompt_hash"):
            return "system_prompt_changed"
        if snapshot.get("tool_schema_hash") != previous.get("tool_schema_hash"):
            return "tool_schema_changed"
        if snapshot.get("message_prefix_hash") != previous.get("message_prefix_hash"):
            return "unknown"
        return "stable_prefix"

    def _write_cache_diagnostic(
        self,
        event: str,
        request: ApiMessageRequest | None,
        params: dict[str, Any],
        *,
        usage: UsageSnapshot | None = None,
        **fields: Any,
    ) -> None:
        if not self._enable_prompt_cache_options and not os.environ.get("MYHARNESS_PROMPT_CACHE_DIAGNOSTICS"):
            return
        try:
            snapshot = self._cache_diagnostic_snapshot(request, params) if request is not None else {}
            cached = int(usage.cached_input_tokens if usage is not None else 0)
            input_tokens = int(usage.input_tokens if usage is not None else 0)
            payload = {
                "ts": time.time(),
                "provider": self._diagnostics_label or "openai-compatible",
                "event": event,
                **snapshot,
                **fields,
            }
            if usage is not None:
                payload.update(
                    {
                        "input_tokens": input_tokens,
                        "cached_input_tokens": cached,
                        "uncached_input_tokens": max(0, input_tokens - cached),
                        "output_tokens": int(usage.output_tokens),
                        "cache_hit_ratio": (cached / input_tokens) if input_tokens > 0 else 0.0,
                    }
                )
            path = get_logs_dir() / "prompt-cache-diagnostics.jsonl"
            with path.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(payload, ensure_ascii=False, sort_keys=True) + "\n")
        except Exception:
            log.debug("failed to write prompt cache diagnostic", exc_info=True)

    @staticmethod
    def _is_retryable(exc: Exception) -> bool:
        status = getattr(exc, "status_code", None)
        if status is None and isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
        if status and status in {429, 500, 502, 503}:
            return True
        if isinstance(exc, (httpx.TimeoutException, httpx.TransportError, ConnectionError, TimeoutError, OSError)):
            return True
        marker = f"{exc.__class__.__name__} {exc}".lower()
        if any(term in marker for term in ("timeout", "timed out", "connection", "network")):
            return True
        return False

    @staticmethod
    def _translate_error(exc: Exception) -> MyHarnessApiError:
        status = getattr(exc, "status_code", None)
        if status is None and isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
        msg = str(exc)
        if status == 401 or status == 403:
            return AuthenticationFailure(msg)
        if status == 429:
            return RateLimitFailure(msg)
        return RequestFailure(msg)


# Matches complete <think>…</think> blocks (DOTALL so newlines are included).
_THINK_RE = re.compile(r"<think>.*?</think>", re.DOTALL)
_THINK_OPEN_TAG = "<think>"


def _strip_think_blocks(buf: str) -> tuple[str, str]:
    """Strip complete ``<think>…</think>`` blocks and return ``(visible_text, leftover)``.

    Complete pairs are removed via regex.  An unclosed ``<think>`` is held in
    *leftover* so it can be re-evaluated once the closing tag arrives in the
    next streaming chunk.
    """
    # Remove fully-closed blocks.
    cleaned = _THINK_RE.sub("", buf)

    # Hold back any unclosed <think> for the next chunk.
    open_idx = cleaned.find(_THINK_OPEN_TAG)
    if open_idx != -1:
        return cleaned[:open_idx], cleaned[open_idx:]

    # Streaming providers may split the opening tag itself across chunk
    # boundaries (e.g. ``"<thi"`` then ``"nk>..."``). Hold back the longest
    # suffix that could still become ``<think>`` on the next chunk.
    max_prefix = min(len(cleaned), len(_THINK_OPEN_TAG) - 1)
    for prefix_len in range(max_prefix, 0, -1):
        if _THINK_OPEN_TAG.startswith(cleaned[-prefix_len:]):
            return cleaned[:-prefix_len], cleaned[-prefix_len:]

    return cleaned, ""
