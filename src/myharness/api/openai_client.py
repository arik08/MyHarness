"""OpenAI-compatible API client for providers like Alibaba DashScope, GitHub Models, etc."""

from __future__ import annotations

import asyncio
import json
import logging
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


def _convert_tools_to_openai(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Convert Anthropic tool schemas to OpenAI function-calling format.

    Anthropic format:
        {"name": "...", "description": "...", "input_schema": {...}}
    OpenAI format:
        {"type": "function", "function": {"name": "...", "description": "...", "parameters": {...}}}
    """
    result = []
    for tool in tools:
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
    ) -> None:
        self._api_key = api_key
        self._base_url = _normalize_openai_base_url(base_url)
        self._timeout = timeout
        self._raw_stream = raw_stream
        self._diagnostics_label = diagnostics_label or ""
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
            "messages": openai_messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        params.update(_token_limit_param_for_model(request.model, request.max_tokens))
        if openai_tools:
            params["tools"] = openai_tools
            # Some providers (Kimi) error on empty reasoning_content in
            # tool-call follow-ups.  Omit the entire stream_options key if
            # tools are present – avoids triggering model-side thinking mode
            # that requires reasoning_content on every assistant message.
            params.pop("stream_options", None)
        return params

    async def _stream_once(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        """Single attempt: stream an OpenAI chat completion."""
        params = self._completion_params(request)

        # Collect full response while streaming text deltas
        collected_content = ""
        collected_reasoning = ""
        collected_tool_calls: dict[int, dict[str, Any]] = {}
        finish_reason: str | None = None
        usage_data: dict[str, int] = {}
        # Buffer to strip inline <think>…</think> blocks across streaming chunks.
        _think_buf = ""

        stream = await self._client.chat.completions.create(**params)
        async for chunk in stream:
            if not chunk.choices:
                # Usage-only chunk (some providers send this at the end)
                if chunk.usage:
                    usage_data = {
                        "input_tokens": chunk.usage.prompt_tokens or 0,
                        "output_tokens": chunk.usage.completion_tokens or 0,
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

        yield ApiMessageCompleteEvent(
            message=final_message,
            usage=UsageSnapshot(
                input_tokens=usage_data.get("input_tokens", 0),
                output_tokens=usage_data.get("output_tokens", 0),
            ),
            stop_reason=finish_reason,
        )

    async def _stream_raw_once(self, request: ApiMessageRequest) -> AsyncIterator[ApiStreamEvent]:
        """Single attempt using a direct SSE reader for OpenAI-compatible providers."""
        params = self._completion_params(request)
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
            async with client.stream(
                "POST",
                self._chat_completions_url(),
                headers=self._raw_stream_headers(),
                json=params,
            ) as response:
                if response.status_code >= 400:
                    payload = await response.aread()
                    message = payload.decode("utf-8", "replace") or f"HTTP {response.status_code}"
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
        yield ApiMessageCompleteEvent(
            message=final_message,
            usage=UsageSnapshot(
                input_tokens=usage_data.get("input_tokens", 0),
                output_tokens=usage_data.get("output_tokens", 0),
            ),
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
            }
        )

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
