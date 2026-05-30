"""Core tool-aware query loop."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from myharness.api.client import (
    ApiMessageCompleteEvent,
    ApiMessageRequest,
    ApiRetryEvent,
    ApiStreamEvent,
    ApiTextDeltaEvent,
    ApiToolCallDeltaEvent,
    SupportsStreamingMessages,
)
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock, ToolResultBlock, ToolUseBlock
from myharness.engine.stream_events import (
    AssistantTextDelta,
    AssistantTurnComplete,
    CompactProgressEvent,
    ErrorEvent,
    StatusEvent,
    StreamEvent,
    ToolExecutionCompleted,
    ToolExecutionStarted,
    ToolInputDelta,
)
from myharness.hooks import HookEvent, HookExecutor
from myharness.learning import run_auto_skill_learning
from myharness.learning.service import remember_tool_failure
from myharness.permissions.checker import PermissionChecker
from myharness.permissions.mutation_lock import (
    MutationLockTimeout,
    acquire_mutation_lock,
)
from myharness.tools.base import ToolExecutionContext
from myharness.tools.base import ToolRegistry

AUTO_COMPACT_STATUS_MESSAGE = "컨텍스트 초과를 막기 위해 이전 대화를 요약합니다."
REACTIVE_COMPACT_STATUS_MESSAGE = "컨텍스트 한도를 넘어 이전 대화를 요약한 뒤 다시 시도합니다."

log = logging.getLogger(__name__)


PermissionPrompt = Callable[[str, str], Awaitable[bool]]
AskUserPrompt = Callable[..., Awaitable[str]]
SteeringProvider = Callable[[], Awaitable[list[str]]]

MAX_TRACKED_READ_FILES = 6
MAX_TRACKED_SKILLS = 8
MAX_TRACKED_ASYNC_AGENT_EVENTS = 8
MAX_TRACKED_ASYNC_AGENT_TASKS = 12
MAX_TRACKED_WORK_LOG = 10
MAX_TRACKED_USER_GOALS = 5
MAX_TRACKED_ACTIVE_ARTIFACTS = 8
MAX_TRACKED_VERIFIED_WORK = 10
MAX_AUTO_CONTINUATIONS = 4
PROVIDER_STREAM_IDLE_FIRST_SECONDS = 7.0
PROVIDER_STREAM_IDLE_REPEAT_SECONDS = 10.0
PROVIDER_STREAM_IDLE_MAX_SECONDS = 600.0
ASYNC_AGENT_FINALIZATION_BLOCK_MESSAGE = (
    "아직 pending worker가 있습니다. 최종 산출물을 만들기 전에 `task_output`/`task_get`으로 worker 결과를 먼저 확인하거나, "
    "필요하면 worker를 중단, 교체, relay, 또는 승계하세요."
)
CONTINUATION_PROMPT = (
    "Continue the previous assistant response exactly where it stopped. "
    "Do not restart, summarize, or mention that you are continuing. "
    "Continue in the same language and format."
)
TRUNCATED_AFTER_CONTINUATIONS_NOTICE = (
    "\n\n[응답이 출력 한도에 여러 번 도달해 여기까지 표시했습니다. "
    "이어서 더 작성하려면 계속 요청해주세요.]"
)


def _is_prompt_too_long_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return any(
        needle in text
        for needle in (
            "prompt too long",
            "context_length_exceeded",
            "input exceeds",
            "context length",
            "maximum context",
            "context window",
            "too many tokens",
            "too large for the model",
            "maximum context length",
        )
    )


def _is_network_error_message(message: str) -> bool:
    text = message.lower()
    return any(
        needle in text
        for needle in (
            "connect",
            "connection",
            "timeout",
            "network",
            "getaddrinfo",
            "gaierror",
            "name or service not known",
            "temporary failure in name resolution",
            "nodename nor servname provided",
            "errno 11001",
        )
    )


def _is_output_truncated_stop_reason(stop_reason: str | None) -> bool:
    normalized = str(stop_reason or "").strip().lower()
    return normalized in {"length", "max_tokens", "max_completion_tokens", "incomplete"}


def _current_async_agent_task_entries(tool_metadata: dict[str, object] | None) -> list[dict[str, object]]:
    if not isinstance(tool_metadata, dict):
        return []
    value = tool_metadata.get("async_agent_tasks")
    if not isinstance(value, list):
        return []
    return [entry for entry in value if isinstance(entry, dict) and str(entry.get("task_id") or "").strip()]


def _has_pending_current_async_agent_tasks(tool_metadata: dict[str, object] | None) -> bool:
    return any(not bool(entry.get("notification_sent")) for entry in _current_async_agent_task_entries(tool_metadata))


_ASYNC_AGENT_FINALIZATION_ALLOWED_TOOLS = {
    "agent",
    "task_output",
    "task_list",
    "task_get",
    "send_message",
    "task_stop",
    "task_update",
    "read_file",
    "grep",
    "glob",
    "web_search",
    "web_fetch",
    "list_mcp_resources",
    "read_mcp_resource",
    "tool_search",
    "lsp",
}

_ASYNC_AGENT_ALWAYS_FINALIZING_TOOLS = {"write_file", "write_long_report"}
_HUMAN_FACING_OUTPUT_EXTENSIONS = {".html", ".htm", ".md", ".docx", ".pptx", ".xlsx", ".pdf"}
_AUTO_FINAL_WRITE_EXTENSIONS = {".html", ".htm", ".md", ".markdown", ".txt"}
_TARGET_LENGTH_CHECK_MARKER = "[Target length check]"
_HUMAN_FACING_OUTPUT_HINTS = (
    "outputs/",
    "outputs\\",
    "report",
    "dashboard",
    "artifact",
    "deliverable",
    "보고서",
    "대시보드",
    "산출물",
)
_SHELL_WRITE_HINTS = (
    ">",
    "out-file",
    "set-content",
    "add-content",
    "new-item",
    "write_file",
    "write-long-report",
    "pandoc",
    "python -c",
    "node -e",
)


def _tool_input_path_values(tool_input: dict[str, object]) -> list[str]:
    values: list[str] = []
    for key in ("path", "file_path", "output_path", "destination", "target"):
        value = tool_input.get(key)
        if isinstance(value, str) and value.strip():
            values.append(value.strip())
    return values


def _looks_like_human_facing_output_path(path: str) -> bool:
    normalized = path.strip().replace("\\", "/").lower()
    suffix = Path(normalized).suffix
    return suffix in _HUMAN_FACING_OUTPUT_EXTENSIONS or any(hint in normalized for hint in _HUMAN_FACING_OUTPUT_HINTS)


def _looks_like_finalizing_shell_command(command: str) -> bool:
    normalized = command.strip().lower().replace("\\", "/")
    if not normalized:
        return False
    has_output_target = any(ext in normalized for ext in _HUMAN_FACING_OUTPUT_EXTENSIONS) or any(
        hint.replace("\\", "/") in normalized for hint in _HUMAN_FACING_OUTPUT_HINTS
    )
    has_write_action = any(hint in normalized for hint in _SHELL_WRITE_HINTS)
    return has_output_target and has_write_action


def _autofinal_artifact_items(
    tool_calls: list[ToolUseBlock],
    tool_results: list[ToolResultBlock],
) -> list[dict[str, str]]:
    if len(tool_calls) != len(tool_results) or not tool_calls:
        return []
    artifacts: list[dict[str, str]] = []
    for tool_call, result in zip(tool_calls, tool_results, strict=True):
        if result.is_error:
            return []
        if _TARGET_LENGTH_CHECK_MARKER in result.content:
            return []
        if tool_call.name.strip().lower() != "write_file":
            return []
        path_values = _tool_input_path_values(tool_call.input)
        if not path_values:
            return []
        path = path_values[0].replace("\\", "/").strip()
        if Path(path).suffix.lower() not in _AUTO_FINAL_WRITE_EXTENSIONS:
            return []
        artifacts.append({"path": path})
    return artifacts


def _artifact_marker_message(artifacts: list[dict[str, str]]) -> ConversationMessage:
    payload = json.dumps({"artifacts": artifacts}, ensure_ascii=False, separators=(",", ":"))
    return ConversationMessage(
        role="assistant",
        content=[TextBlock(text=f"<myharness-artifacts>{payload}</myharness-artifacts>")],
    )


def _should_block_async_agent_finalization_tool(
    tool_name: str,
    tool_input: dict[str, object],
    tool_metadata: dict[str, object] | None,
) -> bool:
    if not _has_pending_current_async_agent_tasks(tool_metadata):
        return False
    normalized_name = tool_name.strip().lower()
    if normalized_name in _ASYNC_AGENT_FINALIZATION_ALLOWED_TOOLS:
        return False
    if normalized_name in _ASYNC_AGENT_ALWAYS_FINALIZING_TOOLS:
        return True
    if normalized_name in {"bash", "cmd"}:
        return _looks_like_finalizing_shell_command(str(tool_input.get("command") or ""))
    if normalized_name in {"edit_file", "notebook_edit"}:
        return any(_looks_like_human_facing_output_path(path) for path in _tool_input_path_values(tool_input))
    return False


def _add_usage(left: UsageSnapshot, right: UsageSnapshot) -> UsageSnapshot:
    return UsageSnapshot(
        input_tokens=left.input_tokens + right.input_tokens,
        output_tokens=left.output_tokens + right.output_tokens,
        cached_input_tokens=left.cached_input_tokens + right.cached_input_tokens,
    )


def _raw_message_text(message: ConversationMessage) -> str:
    return "".join(block.text for block in message.content if isinstance(block, TextBlock))


def _combine_continued_assistant_message(
    previous_text_parts: list[str],
    final_message: ConversationMessage,
    *,
    append_notice: bool = False,
) -> ConversationMessage:
    text = "".join([*previous_text_parts, _raw_message_text(final_message)])
    if append_notice:
        text = f"{text}{TRUNCATED_AFTER_CONTINUATIONS_NOTICE}"
    non_text_blocks = [block for block in final_message.content if isinstance(block, ToolUseBlock)]
    content = [TextBlock(text=text)] if text else []
    content.extend(non_text_blocks)
    return ConversationMessage(role="assistant", content=content)


class MaxTurnsExceeded(RuntimeError):
    """Raised when the agent exceeds the configured max_turns for one user prompt."""

    def __init__(self, max_turns: int) -> None:
        super().__init__(f"Exceeded maximum turn limit ({max_turns})")
        self.max_turns = max_turns


@dataclass
class QueryContext:
    """Context shared across a query run."""

    api_client: SupportsStreamingMessages
    tool_registry: ToolRegistry
    permission_checker: PermissionChecker
    cwd: Path
    model: str
    system_prompt: str
    max_tokens: int
    reasoning_effort: str | None = None
    context_window_tokens: int | None = None
    auto_compact_threshold_tokens: int | None = None
    permission_prompt: PermissionPrompt | None = None
    ask_user_prompt: AskUserPrompt | None = None
    steering_provider: SteeringProvider | None = None
    max_turns: int | None = 200
    hook_executor: HookExecutor | None = None
    tool_metadata: dict[str, object] | None = None
    auto_skill_learning_enabled: bool = True


INTERNAL_STEERING_PREFIX = "OH_INTERNAL_STEERING:"


def format_internal_steering_update(text: str) -> str:
    return f"{INTERNAL_STEERING_PREFIX}{text.strip()}"


def _format_steering_prompt(text: str) -> str:
    return (
        "The user sent this steering update while you were already working. "
        "Treat it as the latest instruction, adjust course if it conflicts with earlier work, "
        "and avoid continuing work that the user has redirected.\n"
        "User steering update:\n"
        f"{text.strip()}"
    )


def _format_internal_steering_prompt(text: str) -> str:
    return (
        "Internal coordination note for this turn. "
        "Use it as execution guidance, but do not mention the note itself to the user.\n"
        f"{text.strip()}"
    )


def _provider_stream_idle_message(context: QueryContext) -> str:
    metadata = context.tool_metadata or {}
    active_profile = str(metadata.get("active_profile") or "").strip().lower()
    if "pgpt" in active_profile or "p-gpt" in active_profile:
        return "P-GPT 응답을 기다리고 있습니다."
    return "AI 응답을 기다리고 있습니다."


async def _stream_provider_events_with_idle_status(
    context: QueryContext,
    request: ApiMessageRequest,
) -> AsyncIterator[ApiStreamEvent | StatusEvent]:
    queue: asyncio.Queue[ApiStreamEvent | BaseException | None] = asyncio.Queue()

    async def _produce() -> None:
        try:
            async for event in context.api_client.stream_message(request):
                await queue.put(event)
        except BaseException as exc:
            await queue.put(exc)
        finally:
            await queue.put(None)

    task = asyncio.create_task(_produce())
    timeout = max(0.0, PROVIDER_STREAM_IDLE_FIRST_SECONDS)
    repeat = max(0.0, PROVIDER_STREAM_IDLE_REPEAT_SECONDS)
    max_idle = max(0.0, float(os.environ.get("MYHARNESS_PROVIDER_STREAM_IDLE_MAX_SECONDS") or PROVIDER_STREAM_IDLE_MAX_SECONDS))
    idle_started_at: float | None = None
    try:
        while True:
            try:
                item = await asyncio.wait_for(queue.get(), timeout=timeout or None)
            except asyncio.TimeoutError:
                now = time.monotonic()
                idle_started_at = idle_started_at or now
                if max_idle and now - idle_started_at >= max_idle:
                    raise TimeoutError(
                        f"Provider stream produced no events for {max_idle:.0f} seconds."
                    )
                yield StatusEvent(message=_provider_stream_idle_message(context))
                timeout = repeat
                continue
            if item is None:
                return
            if isinstance(item, BaseException):
                raise item
            timeout = repeat
            idle_started_at = None
            yield item
    finally:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)


async def _drain_steering_messages(
    context: QueryContext,
    messages: list[ConversationMessage],
) -> int:
    if context.steering_provider is None:
        return 0
    updates = [
        update.strip()
        for update in await context.steering_provider()
        if update and update.strip()
    ]
    user_visible_count = 0
    for update in updates:
        if update.startswith(INTERNAL_STEERING_PREFIX):
            internal_update = update[len(INTERNAL_STEERING_PREFIX):].strip()
            if internal_update:
                messages.append(ConversationMessage.from_user_text(_format_internal_steering_prompt(internal_update)))
            continue
        remember_user_goal(context.tool_metadata, update)
        messages.append(ConversationMessage.from_user_text(_format_steering_prompt(update)))
        user_visible_count += 1
    return user_visible_count


def _append_capped_unique(bucket: list[Any], value: Any, *, limit: int) -> None:
    if value in bucket:
        bucket.remove(value)
    bucket.append(value)
    if len(bucket) > limit:
        del bucket[:-limit]


def _task_focus_state(tool_metadata: dict[str, object] | None) -> dict[str, object]:
    if tool_metadata is None:
        return {}
    value = tool_metadata.setdefault(
        "task_focus_state",
        {
            "goal": "",
            "recent_goals": [],
            "active_artifacts": [],
            "verified_state": [],
            "next_step": "",
        },
    )
    if isinstance(value, dict):
        value.setdefault("goal", "")
        value.setdefault("recent_goals", [])
        value.setdefault("active_artifacts", [])
        value.setdefault("verified_state", [])
        value.setdefault("next_step", "")
        return value
    replacement = {
        "goal": "",
        "recent_goals": [],
        "active_artifacts": [],
        "verified_state": [],
        "next_step": "",
    }
    tool_metadata["task_focus_state"] = replacement
    return replacement


def _summarize_focus_text(text: str) -> str:
    normalized = " ".join(text.split())
    if not normalized:
        return ""
    return normalized[:240]


def remember_user_goal(
    tool_metadata: dict[str, object] | None,
    prompt: str,
) -> None:
    state = _task_focus_state(tool_metadata)
    summary = _summarize_focus_text(prompt)
    if not summary:
        return
    recent_goals = state.setdefault("recent_goals", [])
    if isinstance(recent_goals, list):
        _append_capped_unique(recent_goals, summary, limit=MAX_TRACKED_USER_GOALS)
    state["goal"] = summary


def _remember_active_artifact(
    tool_metadata: dict[str, object] | None,
    artifact: str,
) -> None:
    normalized = artifact.strip()
    if not normalized:
        return
    state = _task_focus_state(tool_metadata)
    artifacts = state.setdefault("active_artifacts", [])
    if isinstance(artifacts, list):
        _append_capped_unique(artifacts, normalized[:240], limit=MAX_TRACKED_ACTIVE_ARTIFACTS)


def _remember_verified_work(
    tool_metadata: dict[str, object] | None,
    entry: str,
) -> None:
    normalized = entry.strip()
    if not normalized:
        return
    bucket = _tool_metadata_bucket(tool_metadata, "recent_verified_work")
    _append_capped_unique(bucket, normalized[:320], limit=MAX_TRACKED_VERIFIED_WORK)
    state = _task_focus_state(tool_metadata)
    verified_state = state.setdefault("verified_state", [])
    if isinstance(verified_state, list):
        _append_capped_unique(verified_state, normalized[:320], limit=MAX_TRACKED_VERIFIED_WORK)


def _tool_metadata_bucket(
    tool_metadata: dict[str, object] | None,
    key: str,
) -> list[Any]:
    if tool_metadata is None:
        return []
    value = tool_metadata.setdefault(key, [])
    if isinstance(value, list):
        return value
    replacement: list[Any] = []
    tool_metadata[key] = replacement
    return replacement


def _remember_read_file(
    tool_metadata: dict[str, object] | None,
    *,
    path: str,
    offset: int,
    limit: int,
    output: str,
) -> None:
    bucket = _tool_metadata_bucket(tool_metadata, "read_file_state")
    preview_lines = [line.strip() for line in output.splitlines()[:6] if line.strip()]
    entry = {
        "path": path,
        "span": f"lines {offset + 1}-{offset + limit}",
        "preview": " | ".join(preview_lines)[:320],
        "timestamp": time.time(),
    }
    if isinstance(bucket, list):
        bucket[:] = [
            existing
            for existing in bucket
            if not isinstance(existing, dict) or str(existing.get("path") or "") != path
        ]
        bucket.append(entry)
        if len(bucket) > MAX_TRACKED_READ_FILES:
            del bucket[:-MAX_TRACKED_READ_FILES]


def _remember_skill_invocation(
    tool_metadata: dict[str, object] | None,
    *,
    skill_name: str,
) -> None:
    bucket = _tool_metadata_bucket(tool_metadata, "invoked_skills")
    normalized = skill_name.strip()
    if not normalized:
        return
    if normalized in bucket:
        bucket.remove(normalized)
    bucket.append(normalized)
    if len(bucket) > MAX_TRACKED_SKILLS:
        del bucket[:-MAX_TRACKED_SKILLS]


def _remember_async_agent_activity(
    tool_metadata: dict[str, object] | None,
    *,
    tool_name: str,
    tool_input: dict[str, object],
    output: str,
) -> None:
    bucket = _tool_metadata_bucket(tool_metadata, "async_agent_state")
    if tool_name == "agent":
        description = str(tool_input.get("description") or tool_input.get("prompt") or "").strip()
        summary = f"Spawned async agent. {description}".strip()
        if output.strip():
            summary = f"{summary} [{output.strip()[:180]}]".strip()
    elif tool_name == "send_message":
        target = str(tool_input.get("task_id") or "").strip()
        summary = f"Sent follow-up message to async agent {target}".strip()
    else:
        summary = output.strip()[:220] or f"Async agent activity via {tool_name}"
    bucket.append(summary)
    if len(bucket) > MAX_TRACKED_ASYNC_AGENT_EVENTS:
        del bucket[:-MAX_TRACKED_ASYNC_AGENT_EVENTS]


def _parse_spawned_agent_identity(
    output: str,
    metadata: dict[str, object] | None = None,
) -> tuple[str, str] | None:
    if isinstance(metadata, dict):
        agent_id = str(metadata.get("agent_id") or "").strip()
        task_id = str(metadata.get("task_id") or "").strip()
        if agent_id and task_id:
            return agent_id, task_id
    match = re.search(r"Spawned agent (.+?) \(task_id=(\S+?)(?:[,)]|$)", output.strip())
    if match is None:
        return None
    return match.group(1).strip(), match.group(2).strip()


def _remember_async_agent_task(
    tool_metadata: dict[str, object] | None,
    *,
    tool_name: str,
    tool_input: dict[str, object],
    output: str,
    result_metadata: dict[str, object] | None = None,
) -> None:
    if tool_name != "agent":
        return
    identity = _parse_spawned_agent_identity(output, result_metadata)
    if identity is None:
        return
    agent_id, task_id = identity
    bucket = _tool_metadata_bucket(tool_metadata, "async_agent_tasks")
    description = str(tool_input.get("description") or tool_input.get("prompt") or "").strip()
    entry = {
        "agent_id": agent_id,
        "task_id": task_id,
        "description": description[:240],
        "status": "spawned",
        "notification_sent": False,
        "spawned_at": time.time(),
    }
    bucket[:] = [
        existing
        for existing in bucket
        if not isinstance(existing, dict) or str(existing.get("task_id") or "") != task_id
    ]
    bucket.append(entry)
    if len(bucket) > MAX_TRACKED_ASYNC_AGENT_TASKS:
        del bucket[:-MAX_TRACKED_ASYNC_AGENT_TASKS]


def _remember_work_log(
    tool_metadata: dict[str, object] | None,
    *,
    entry: str,
) -> None:
    bucket = _tool_metadata_bucket(tool_metadata, "recent_work_log")
    normalized = entry.strip()
    if not normalized:
        return
    bucket.append(normalized[:320])
    if len(bucket) > MAX_TRACKED_WORK_LOG:
        del bucket[:-MAX_TRACKED_WORK_LOG]


def _update_plan_mode(tool_metadata: dict[str, object] | None, mode: str) -> None:
    if tool_metadata is None:
        return
    tool_metadata["permission_mode"] = mode


def _record_tool_carryover(
    context: QueryContext,
    *,
    tool_name: str,
    tool_input: dict[str, object],
    tool_output: str,
    tool_result_metadata: dict[str, object] | None,
    is_error: bool,
    resolved_file_path: str | None,
) -> None:
    if is_error:
        remember_tool_failure(
            context.tool_metadata,
            tool_name=tool_name,
            tool_input=tool_input,
            tool_output=tool_output,
        )
        return
    if resolved_file_path is not None:
        _remember_active_artifact(context.tool_metadata, resolved_file_path)
    if tool_name == "read_file" and resolved_file_path is not None:
        offset = int(tool_input.get("offset") or 0)
        limit = int(tool_input.get("limit") or 200)
        _remember_read_file(
            context.tool_metadata,
            path=resolved_file_path,
            offset=offset,
            limit=limit,
            output=tool_output,
        )
        _remember_verified_work(
            context.tool_metadata,
            f"Inspected file {resolved_file_path} (lines {offset + 1}-{offset + limit})",
        )
    elif tool_name == "skill":
        _remember_skill_invocation(
            context.tool_metadata,
            skill_name=str(tool_input.get("name") or ""),
        )
        skill_name = str(tool_input.get("name") or "").strip()
        if skill_name:
            _remember_active_artifact(context.tool_metadata, f"skill:{skill_name}")
            _remember_verified_work(context.tool_metadata, f"Loaded skill {skill_name}")
    elif tool_name in {"agent", "send_message"}:
        _remember_async_agent_activity(
            context.tool_metadata,
            tool_name=tool_name,
            tool_input=tool_input,
            output=tool_output,
        )
        _remember_async_agent_task(
            context.tool_metadata,
            tool_name=tool_name,
            tool_input=tool_input,
            output=tool_output,
            result_metadata=tool_result_metadata,
        )
        description = str(tool_input.get("description") or tool_input.get("prompt") or tool_name).strip()
        _remember_verified_work(
            context.tool_metadata,
            f"Confirmed async-agent activity via {tool_name}: {description[:180]}",
        )
    elif tool_name == "enter_plan_mode":
        _update_plan_mode(context.tool_metadata, str((tool_result_metadata or {}).get("permission_mode") or "plan"))
        if context.tool_metadata is not None and tool_result_metadata:
            context.tool_metadata["plan_previous_permission_mode"] = str(
                tool_result_metadata.get("plan_previous_permission_mode") or ""
            )
    elif tool_name == "exit_plan_mode":
        _update_plan_mode(context.tool_metadata, str((tool_result_metadata or {}).get("permission_mode") or "default"))
        if context.tool_metadata is not None:
            context.tool_metadata["plan_previous_permission_mode"] = ""
    elif tool_name == "web_fetch":
        url = str(tool_input.get("url") or "").strip()
        if url:
            _remember_active_artifact(context.tool_metadata, url)
            _remember_verified_work(context.tool_metadata, f"Fetched remote content from {url}")
    elif tool_name == "web_search":
        query = str(tool_input.get("query") or "").strip()
        if query:
            _remember_verified_work(context.tool_metadata, f"Ran web search for {query[:180]}")
    elif tool_name == "glob":
        pattern = str(tool_input.get("pattern") or "").strip()
        if pattern:
            _remember_verified_work(context.tool_metadata, f"Expanded glob pattern {pattern[:180]}")
    elif tool_name == "grep":
        pattern = str(tool_input.get("pattern") or "").strip()
        if pattern:
            _remember_verified_work(context.tool_metadata, f"Checked repository matches for grep pattern {pattern[:180]}")
    elif tool_name in {"bash", "cmd"}:
        command = str(tool_input.get("command") or "").strip()
        summary = tool_output.splitlines()[0].strip() if tool_output.strip() else "no output"
        _remember_verified_work(
            context.tool_metadata,
            f"Ran command {command[:160]} [{summary[:120]}]",
        )
    if tool_name == "read_file" and resolved_file_path is not None:
        _remember_work_log(
            context.tool_metadata,
            entry=f"Read file {resolved_file_path}",
        )
    elif tool_name in {"bash", "cmd"}:
        command = str(tool_input.get("command") or "").strip()
        summary = tool_output.splitlines()[0].strip() if tool_output.strip() else "no output"
        _remember_work_log(
            context.tool_metadata,
            entry=f"Ran command: {command[:160]} [{summary[:120]}]",
        )
    elif tool_name == "grep":
        pattern = str(tool_input.get("pattern") or "").strip()
        _remember_work_log(
            context.tool_metadata,
            entry=f"Searched with grep pattern={pattern[:160]}",
        )
    elif tool_name == "skill":
        _remember_work_log(
            context.tool_metadata,
            entry=f"Loaded skill {str(tool_input.get('name') or '').strip()}",
        )
    elif tool_name in {"agent", "send_message"}:
        _remember_work_log(
            context.tool_metadata,
            entry=f"Async agent action via {tool_name}",
        )
    elif tool_name == "enter_plan_mode":
        _remember_work_log(context.tool_metadata, entry="Entered plan mode")
    elif tool_name == "exit_plan_mode":
        _remember_work_log(context.tool_metadata, entry="Exited plan mode")


async def run_query(
    context: QueryContext,
    messages: list[ConversationMessage],
) -> AsyncIterator[tuple[StreamEvent, UsageSnapshot | None]]:
    """Run the conversation loop until the model stops requesting tools.

    Auto-compaction is checked at the start of each turn.  When the
    estimated token count exceeds the model's auto-compact threshold,
    the engine first tries a cheap microcompact (clearing old tool result
    content) and, if that is not enough, performs a full LLM-based
    summarization of older messages.
    """
    from myharness.services.compact import (
        AutoCompactState,
        auto_compact_if_needed,
    )

    compact_state = AutoCompactState()
    reactive_compact_attempted = False
    last_compaction_result: tuple[list[ConversationMessage], bool] = (messages, False)

    async def _stream_compaction(
        *,
        trigger: str,
        force: bool = False,
    ) -> AsyncIterator[tuple[StreamEvent, UsageSnapshot | None]]:
        nonlocal last_compaction_result
        progress_queue: asyncio.Queue[CompactProgressEvent] = asyncio.Queue()

        async def _progress(event: CompactProgressEvent) -> None:
            await progress_queue.put(event)

        task = asyncio.create_task(
            auto_compact_if_needed(
                messages,
                api_client=context.api_client,
                model=context.model,
                system_prompt=context.system_prompt,
                state=compact_state,
                progress_callback=_progress,
                force=force,
                trigger=trigger,
                hook_executor=context.hook_executor,
                carryover_metadata=context.tool_metadata,
                context_window_tokens=context.context_window_tokens,
                auto_compact_threshold_tokens=context.auto_compact_threshold_tokens,
            )
        )
        while True:
            try:
                event = await asyncio.wait_for(progress_queue.get(), timeout=0.05)
                yield event, None
            except asyncio.TimeoutError:
                if task.done():
                    break
                continue
        while not progress_queue.empty():
            yield progress_queue.get_nowait(), None
        last_compaction_result = await task
        return

    def _adopt_compaction_result() -> bool:
        compacted_messages, was_compacted = last_compaction_result
        if was_compacted and compacted_messages is not messages:
            messages[:] = compacted_messages
        return was_compacted

    turn_count = 0
    continuation_start_index: int | None = None
    continued_text_parts: list[str] = []
    continued_usage = UsageSnapshot()
    continuation_count = 0
    continuation_status_sent = False
    while context.max_turns is None or turn_count < context.max_turns:
        turn_count += 1
        # --- auto-compact check before calling the model ---------------
        async for event, usage in _stream_compaction(trigger="auto"):
            yield event, usage
        _adopt_compaction_result()
        steering_count = await _drain_steering_messages(context, messages)
        if steering_count:
            yield StatusEvent(
                message="추가 요청을 반영합니다."
            ), None
        # ---------------------------------------------------------------

        final_message: ConversationMessage | None = None
        usage = UsageSnapshot()
        stop_reason: str | None = None

        try:
            request = ApiMessageRequest(
                model=context.model,
                messages=messages,
                system_prompt=context.system_prompt,
                max_tokens=context.max_tokens,
                tools=context.tool_registry.to_api_schema(),
                reasoning_effort=context.reasoning_effort,
            )
            async for event in _stream_provider_events_with_idle_status(context, request):
                if isinstance(event, StatusEvent):
                    yield event, None
                    continue
                if isinstance(event, ApiTextDeltaEvent):
                    yield AssistantTextDelta(text=event.text), None
                    continue
                if isinstance(event, ApiToolCallDeltaEvent):
                    yield ToolInputDelta(
                        index=event.index,
                        name=event.name,
                        arguments_delta=event.arguments_delta,
                    ), None
                    continue
                if isinstance(event, ApiRetryEvent):
                    yield StatusEvent(
                        message=(
                            "연결이 잠시 끊겨 재시도합니다. "
                            f"{event.delay_seconds:.1f}초 후 다시 시도합니다 "
                            f"({event.attempt + 1}/{event.max_attempts})."
                        )
                    ), None
                    continue

                if isinstance(event, ApiMessageCompleteEvent):
                    final_message = event.message
                    usage = event.usage
                    stop_reason = event.stop_reason
        except Exception as exc:
            error_msg = str(exc)
            if not reactive_compact_attempted and _is_prompt_too_long_error(exc):
                reactive_compact_attempted = True
                yield StatusEvent(message=REACTIVE_COMPACT_STATUS_MESSAGE), None
                async for event, usage in _stream_compaction(trigger="reactive", force=True):
                    yield event, usage
                if _adopt_compaction_result():
                    continue
            if _is_network_error_message(error_msg):
                yield ErrorEvent(message=f"Network error: {error_msg}. Check your internet connection and try again."), None
            else:
                yield ErrorEvent(message=f"API error: {error_msg}"), None
            return

        if final_message is None:
            raise RuntimeError("Model stream finished without a final message")

        coordinator_context_message: ConversationMessage | None = None
        if context.system_prompt.startswith("You are a **coordinator**."):
            if messages and messages[-1].role == "user" and messages[-1].text.startswith("# Coordinator User Context"):
                coordinator_context_message = messages.pop()

        if final_message.role == "assistant" and final_message.is_effectively_empty():
            log.warning("dropping empty assistant message from provider response")
            yield ErrorEvent(
                message=(
                    "Model returned an empty assistant message. "
                    "The turn was ignored to keep the session healthy."
                )
            ), usage
            return

        output_truncated = _is_output_truncated_stop_reason(stop_reason)
        if output_truncated and not final_message.tool_uses and continuation_count < MAX_AUTO_CONTINUATIONS:
            if continuation_start_index is None:
                continuation_start_index = len(messages)
            messages.append(final_message)
            messages.append(ConversationMessage.from_user_text(CONTINUATION_PROMPT))
            continued_text_parts.append(_raw_message_text(final_message))
            continued_usage = _add_usage(continued_usage, usage)
            continuation_count += 1
            if not continuation_status_sent:
                continuation_status_sent = True
                yield StatusEvent(message="응답이 출력 한도에 도달해 자동으로 이어서 작성합니다."), None
            continue

        if continuation_start_index is not None:
            final_message = _combine_continued_assistant_message(
                continued_text_parts,
                final_message,
                append_notice=output_truncated and not final_message.tool_uses,
            )
            usage = _add_usage(continued_usage, usage)
            del messages[continuation_start_index:]
            continuation_start_index = None
            continued_text_parts = []
            continued_usage = UsageSnapshot()
            continuation_count = 0
            continuation_status_sent = False

        messages.append(final_message)
        yield AssistantTurnComplete(message=final_message, usage=usage), usage

        if coordinator_context_message is not None:
            messages.append(coordinator_context_message)

        if not final_message.tool_uses:
            steering_count = await _drain_steering_messages(context, messages)
            if steering_count:
                yield StatusEvent(
                    message="추가 요청을 반영합니다."
                ), None
                continue
            if context.hook_executor is not None:
                await context.hook_executor.execute(
                    HookEvent.STOP,
                    {
                        "event": HookEvent.STOP.value,
                        "stop_reason": "tool_uses_empty",
                    },
                )
            run_auto_skill_learning(
                context.tool_metadata,
                enabled=context.auto_skill_learning_enabled,
            )
            return

        tool_calls = final_message.tool_uses

        if len(tool_calls) == 1:
            # Single tool: sequential (stream events immediately)
            tc = tool_calls[0]
            yield ToolExecutionStarted(
                tool_name=tc.name,
                tool_input=tc.input,
                tool_use_id=tc.id,
                index=0,
            ), None
            result = await _execute_tool_call(context, tc.name, tc.id, tc.input)
            yield ToolExecutionCompleted(
                tool_name=tc.name,
                output=result.display_content or result.content,
                is_error=result.is_error,
                tool_use_id=tc.id,
                index=0,
                transcript_output=result.transcript_content,
            ), None
            tool_results = [result]
        else:
            # Multiple tools: execute concurrently, emit events after
            for index, tc in enumerate(tool_calls):
                yield ToolExecutionStarted(
                    tool_name=tc.name,
                    tool_input=tc.input,
                    tool_use_id=tc.id,
                    index=index,
                ), None

            async def _run(index, tc):
                try:
                    result = await _execute_tool_call(context, tc.name, tc.id, tc.input)
                except Exception as exc:
                    log.exception(
                        "tool execution raised: name=%s id=%s",
                        tc.name,
                        tc.id,
                        exc_info=exc,
                    )
                    result = ToolResultBlock(
                        tool_use_id=tc.id,
                        content=f"Tool {tc.name} failed: {type(exc).__name__}: {exc}",
                        is_error=True,
                    )
                return index, tc, result

            # Emit each completion as soon as that tool finishes so fast tools
            # do not look stuck behind a slower sibling in the UI. Keep the
            # final tool_result message in original tool_use order for providers.
            tasks = [asyncio.create_task(_run(index, tc)) for index, tc in enumerate(tool_calls)]
            tool_results: list[ToolResultBlock | None] = [None] * len(tool_calls)
            try:
                for completed_task in asyncio.as_completed(tasks):
                    index, tc, result = await completed_task
                    tool_results[index] = result
                    yield ToolExecutionCompleted(
                        tool_name=tc.name,
                        output=result.display_content or result.content,
                        is_error=result.is_error,
                        tool_use_id=tc.id,
                        index=index,
                        transcript_output=result.transcript_content,
                    ), None
            finally:
                pending = [task for task in tasks if not task.done()]
                for task in pending:
                    task.cancel()
                if pending:
                    await asyncio.gather(*pending, return_exceptions=True)
            if any(result is None for result in tool_results):
                raise RuntimeError("parallel tool execution finished without all tool results")
            tool_results = [result for result in tool_results if result is not None]

        messages.append(ConversationMessage(role="user", content=tool_results))
        autofinal_artifacts = _autofinal_artifact_items(tool_calls, tool_results)
        if autofinal_artifacts:
            synthetic_message = _artifact_marker_message(autofinal_artifacts)
            synthetic_usage = UsageSnapshot()
            messages.append(synthetic_message)
            yield AssistantTurnComplete(message=synthetic_message, usage=synthetic_usage), synthetic_usage
            if context.hook_executor is not None:
                await context.hook_executor.execute(
                    HookEvent.STOP,
                    {
                        "event": HookEvent.STOP.value,
                        "stop_reason": "artifact_write_complete",
                    },
                )
            run_auto_skill_learning(
                context.tool_metadata,
                enabled=context.auto_skill_learning_enabled,
            )
            return
        steering_count = await _drain_steering_messages(context, messages)
        if steering_count:
            yield StatusEvent(
                message="추가 요청을 반영합니다."
            ), None

    if context.max_turns is not None:
        raise MaxTurnsExceeded(context.max_turns)
    raise RuntimeError("Query loop exited without a max_turns limit or final response")


async def _execute_tool_call(
    context: QueryContext,
    tool_name: str,
    tool_use_id: str,
    tool_input: dict[str, object],
) -> ToolResultBlock:
    if _should_block_async_agent_finalization_tool(tool_name, tool_input, context.tool_metadata):
        return ToolResultBlock(
            tool_use_id=tool_use_id,
            content=ASYNC_AGENT_FINALIZATION_BLOCK_MESSAGE,
            is_error=True,
        )

    if context.hook_executor is not None:
        pre_hooks = await context.hook_executor.execute(
            HookEvent.PRE_TOOL_USE,
            {"tool_name": tool_name, "tool_input": tool_input, "event": HookEvent.PRE_TOOL_USE.value},
        )
        if pre_hooks.blocked:
            return ToolResultBlock(
                tool_use_id=tool_use_id,
                content=pre_hooks.reason or f"pre_tool_use hook blocked {tool_name}",
                is_error=True,
            )

    log.debug("tool_call start: %s id=%s", tool_name, tool_use_id)

    tool = context.tool_registry.get(tool_name)
    if tool is None and tool_name == "bash":
        tool = context.tool_registry.get("cmd")
    if tool is None:
        log.warning("unknown tool: %s", tool_name)
        return ToolResultBlock(
            tool_use_id=tool_use_id,
            content=f"Unknown tool: {tool_name}",
            is_error=True,
        )

    try:
        parsed_input = tool.input_model.model_validate(tool_input)
    except Exception as exc:
        log.warning("invalid input for %s: %s", tool_name, exc)
        return ToolResultBlock(
            tool_use_id=tool_use_id,
            content=f"Invalid input for {tool_name}: {exc}",
            is_error=True,
        )

    # Normalize common tool inputs before permission checks so path rules apply
    # consistently across built-in tools that use `file_path`, `path`, or
    # directory-scoped roots such as `glob`/`grep`.
    _file_path = _resolve_permission_file_path(context.cwd, tool_input, parsed_input)
    _command = _extract_permission_command(tool_input, parsed_input)
    is_read_only = tool.is_read_only(parsed_input)
    log.debug("permission check: %s read_only=%s path=%s cmd=%s",
              tool_name, is_read_only, _file_path, _command and _command[:80])
    decision = context.permission_checker.evaluate(
        tool_name,
        is_read_only=is_read_only,
        file_path=_file_path,
        command=_command,
    )
    if not decision.allowed:
        if decision.requires_confirmation and context.permission_prompt is not None:
            log.debug("permission prompt for %s: %s", tool_name, decision.reason)
            if context.hook_executor is not None:
                await context.hook_executor.execute(
                    HookEvent.NOTIFICATION,
                    {
                        "event": HookEvent.NOTIFICATION.value,
                        "notification_type": "permission_prompt",
                        "tool_name": tool_name,
                        "reason": decision.reason,
                    },
                )
            confirmed = await context.permission_prompt(tool_name, decision.reason)
            if not confirmed:
                log.debug("permission denied by user for %s", tool_name)
                return ToolResultBlock(
                    tool_use_id=tool_use_id,
                    content=decision.reason or f"Permission denied for {tool_name}",
                    is_error=True,
                )
        else:
            log.debug("permission blocked for %s: %s", tool_name, decision.reason)
            return ToolResultBlock(
                tool_use_id=tool_use_id,
                content=decision.reason or f"Permission denied for {tool_name}",
                is_error=True,
            )

    if tool.requires_project_mutation_lock(parsed_input) and context.tool_metadata is not None:
        lock_token = context.tool_metadata.get("mutation_lock_token")
        if lock_token is None:
            owner = str(context.tool_metadata.get("session_id") or os.getpid())
            try:
                context.tool_metadata["mutation_lock_token"] = await acquire_mutation_lock(
                    context.cwd,
                    owner=owner,
                )
            except MutationLockTimeout as exc:
                return ToolResultBlock(
                    tool_use_id=tool_use_id,
                    content=str(exc),
                    is_error=True,
                )

    log.debug("executing %s ...", tool_name)
    t0 = time.monotonic()
    result = await tool.execute(
        parsed_input,
        ToolExecutionContext(
            cwd=context.cwd,
            metadata={
                "_shared_tool_metadata": context.tool_metadata or {},
                "api_client": context.api_client,
                "tool_registry": context.tool_registry,
                "ask_user_prompt": context.ask_user_prompt,
                "model": context.model,
                "system_prompt": context.system_prompt,
                "max_tokens": context.max_tokens,
                "reasoning_effort": context.reasoning_effort,
                **(context.tool_metadata or {}),
            },
            hook_executor=context.hook_executor,
        ),
    )
    elapsed = time.monotonic() - t0
    log.debug("executed %s in %.2fs err=%s output_len=%d",
              tool_name, elapsed, result.is_error, len(result.output or ""))
    model_output = str(result.metadata.get("model_output") or result.output)
    display_output = result.metadata.get("display_output")
    transcript_output = result.metadata.get("transcript_output")
    tool_result = ToolResultBlock(
        tool_use_id=tool_use_id,
        content=model_output,
        is_error=result.is_error,
        display_content=str(display_output) if display_output is not None else None,
        transcript_content=str(transcript_output) if transcript_output is not None else None,
    )
    _record_tool_carryover(
        context,
        tool_name=tool_name,
        tool_input=tool_input,
        tool_output=tool_result.content,
        tool_result_metadata=result.metadata,
        is_error=tool_result.is_error,
        resolved_file_path=_file_path,
    )
    if context.hook_executor is not None:
        await context.hook_executor.execute(
            HookEvent.POST_TOOL_USE,
            {
                "tool_name": tool_name,
                "tool_input": tool_input,
                "tool_output": tool_result.content,
                "tool_is_error": tool_result.is_error,
                "event": HookEvent.POST_TOOL_USE.value,
            },
        )
    return tool_result


def _resolve_permission_file_path(
    cwd: Path,
    raw_input: dict[str, object],
    parsed_input: object,
) -> str | None:
    for key in ("file_path", "path", "root"):
        value = raw_input.get(key)
        if isinstance(value, str) and value.strip():
            path = Path(value).expanduser()
            if not path.is_absolute():
                path = cwd / path
            return str(path.resolve())

    for attr in ("file_path", "path", "root"):
        value = getattr(parsed_input, attr, None)
        if isinstance(value, str) and value.strip():
            path = Path(value).expanduser()
            if not path.is_absolute():
                path = cwd / path
            return str(path.resolve())

    return None


def _extract_permission_command(
    raw_input: dict[str, object],
    parsed_input: object,
) -> str | None:
    value = raw_input.get("command")
    if isinstance(value, str) and value.strip():
        return value

    value = getattr(parsed_input, "command", None)
    if isinstance(value, str) and value.strip():
        return value

    return None
