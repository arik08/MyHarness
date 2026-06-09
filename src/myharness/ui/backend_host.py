"""JSON-lines backend host for the React terminal frontend."""

from __future__ import annotations

import asyncio
import contextlib
import copy
import inspect
import json
import logging
import os
import re
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from myharness.api.client import ApiMessageCompleteEvent, ApiMessageRequest, SupportsStreamingMessages
from myharness.auth.manager import AuthManager
from myharness.commands import CommandContext
from myharness.config.settings import CLAUDE_MODEL_ALIAS_OPTIONS, Settings, resolve_model_setting
from myharness.bridge import get_bridge_manager
from myharness.mcp.config import load_mcp_server_configs
from myharness.mcp.types import McpConnectionStatus
from myharness.themes import list_themes
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
from myharness.engine.messages import ConversationMessage, ImageBlock, TextBlock, ToolResultBlock, sanitize_conversation_messages
from myharness.engine.query import format_internal_steering_update
from myharness.engine.cost_tracker import usage_accounting_delta
from myharness.output_styles import load_output_styles
from myharness.permissions.mutation_lock import release_mutation_lock
from myharness.project_preferences import (
    load_project_preferences,
    set_project_mcp_enabled,
    set_project_plugin_enabled,
    set_project_skill_enabled,
)
from myharness.prompts import build_runtime_system_prompt
from myharness.services.long_report_progress import read_long_report_progress_state
from myharness.services.session_storage import (
    fallback_session_title_from_user_text,
    title_echoes_first_user,
    title_matches_first_user,
)
from myharness.skills import load_skill_registry
from myharness.skills.display import display_skill_description
from myharness.skills.loader import is_learned_skill
from myharness.skills.routing import is_mcp_routed_skill_source, mcp_server_name_from_skill_source
from myharness.skills.state import apply_skill_enabled_state
from myharness.skills.types import SkillDefinition
from myharness.subagents import SUBAGENT_INVOCATION_DISABLED_MESSAGE, is_subagent_invocation_enabled
from myharness.tasks import get_task_manager
from myharness.tools import ToolRegistry
from myharness.tools.mcp_tool import McpToolAdapter, _sanitize_tool_segment
from myharness.ui.async_agents import (
    format_completed_task_notifications,
    pending_async_agent_entries,
    wait_for_completed_async_agent_entries,
)
from myharness.ui.protocol import BackendEvent, FrontendRequest, PluginSnapshot, SkillSnapshot, TranscriptItem
from myharness.ui.runtime import build_runtime, close_runtime, handle_line, refresh_runtime_client, start_runtime, sync_app_state
from myharness.services.session_backend import SessionBackend

log = logging.getLogger(__name__)

log = logging.getLogger(__name__)

_PROTOCOL_PREFIX = "OHJSON:"
_BUILT_IN_SKILL_SOURCES = {"bundled"}
_TOOL_PROGRESS_FIRST_DELAY_SECONDS = 2.5
_TOOL_PROGRESS_INTERVAL_SECONDS = 3.0
_ASSISTANT_DELTA_FLUSH_INTERVAL_SECONDS = 0.12
_LONG_REPORT_PROGRESS_FIRST_DELAY_SECONDS = 1.5
_LONG_REPORT_PROGRESS_INTERVAL_SECONDS = 2.0
_LONG_REPORT_PROGRESS_READ_LIMIT = 96_000
_LONG_REPORT_PROGRESS_DISPLAY_LIMIT = 48_000
_SWARM_STATUS_INTERVAL_SECONDS = 2.0
_ASSISTANT_PROGRESS_OPEN = "<myharness-progress>"
_ASSISTANT_PROGRESS_CLOSE = "</myharness-progress>"
_ASSISTANT_ARTIFACTS_OPEN = "<myharness-artifacts>"
_ASSISTANT_ARTIFACTS_CLOSE = "</myharness-artifacts>"
_SWARM_STRAGGLER_MIN_SECONDS = 10 * 60
_SWARM_STRAGGLER_PEER_FACTOR = 3.0
_SWARM_STRAGGLER_WAVE_WINDOW_SECONDS = 15 * 60
_SWARM_ORCHESTRATION_CHECKPOINT_SECONDS = 60
_SWARM_NO_PROGRESS_SECONDS = 2 * 60
_SWARM_TASK_TYPES = {"local_agent", "remote_agent", "in_process_teammate"}
_SAVED_SESSION_ID_RE = re.compile(r"^[0-9a-f]{12}$")
_SESSION_TITLE_SOURCE_PROMPT = "prompt"
_SESSION_TITLE_SOURCE_CONVERSATION = "conversation"
_SWARM_DELEGATION_HINT = (
    "The user explicitly asked to divide the work across roles or an AI team. "
    "First sketch a lightweight workflow/DAG: identify which roles can run in parallel now, "
    "which roles depend on earlier evidence, and where you will merge results. "
    "Show that workflow in a fenced `mermaid` block using `flowchart LR` or `flowchart TD`, "
    "with labeled nodes and arrows that MyHarness can render as a chart. "
    "Use labels that fit the actual task, not a fixed 조사/정리/검토 template; e.g. "
    "`flowchart LR; A[요건 파악: 범위 확인] --> B[데이터 수집: 원천 수집] --> C[정규화: 스키마 맞춤] --> D[검증: 결과 확인]`. "
    "Do not use raw ASCII art or the old `workflow` fence for the workflow. "
    "Use the `agent` tool now only for the current independent wave of focused background workers. "
    "Do not spawn serial downstream roles prematurely: roles with unmet prerequisites wait until their inputs exist. "
    "Keep each wave controlled: usually use at most 10 workers per wave, give each worker a non-overlapping scope, "
    "and size the expected depth to the assignment. For quick slices, ask for concise bullets; for substantial analysis, "
    "ask for enough evidence, calculations, caveats, and intermediate tables to support a reliable synthesis. "
    "Prefer more workers only when they reduce wall-clock time. "
    "For web/office research, tell each worker to check the relevant sources needed for its role and avoid duplicating "
    "the other workers' searches. "
    "Tell each worker to emit compact JSON progress via `task_update` as part of its natural output flow, without waiting "
    "for the parent to ask. Progress should appear when the worker learns something material, starts a new phase, changes "
    "direction, finds a blocker, or has a handoff-ready fact. Do not ask workers to report after every tool call or send "
    "generic 'still working' heartbeats. Short progress lines are acceptable only when `task_update` is unavailable, so the "
    "AI 팀 panel can stay fresh without extra reminder prompts. "
    "Act as the main orchestrator while workers run: periodically inspect worker progress with `task_output`, relay useful findings "
    "or missing prerequisites to other workers with `send_message`, and adjust the plan as evidence arrives. "
    "Do not wait passively for every worker when partial results are enough to unblock the next step. "
    "After launching a parallel wave, watch for stragglers: if most workers finish within a few minutes but one worker "
    "runs much longer, inspect it briefly, stop it with `task_stop`, and either spawn a narrower replacement, spawn a stronger "
    "replacement with `model=\"inherit\"`, or finish that slice in the main agent. Do not let one lagging worker block the whole task. "
    "For office/research tasks, use role names such as 조사, 정리, and 검토 only when they fit the actual workflow, "
    "and treat every label as a workflow node rather than a hard-coded stage. "
    "Use worker descriptions with visible role labels, such as `조사 담당: 전력 용량 출처 확인`, "
    "so the AI 팀 panel can show what each worker owns. "
    "Give each worker a self-contained prompt, set team to `office`, and use a fitting preset `subagent_type` when one applies; "
    "otherwise omit `subagent_type` for an ad-hoc worker. "
    "After spawning workers, briefly tell the user the workflow shape and which workers started in the current wave. "
    "Do not present final research conclusions until worker results are available."
)


class _AssistantProgressFilter:
    """Extract same-stream progress JSON markers from assistant text."""

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, text: str) -> tuple[str, list[str]]:
        self._buffer += text
        return self._drain(final=False)

    def flush(self) -> tuple[str, list[str]]:
        return self._drain(final=True)

    def strip(self, text: str) -> tuple[str, list[str]]:
        self._buffer = text
        return self._drain(final=True)

    def _drain(self, *, final: bool) -> tuple[str, list[str]]:
        visible_parts: list[str] = []
        progress_messages: list[str] = []
        while self._buffer:
            start = self._buffer.find(_ASSISTANT_PROGRESS_OPEN)
            if start < 0:
                if final:
                    visible_parts.append(self._buffer)
                    self._buffer = ""
                    break
                keep = _assistant_progress_prefix_keep(self._buffer)
                emit_len = len(self._buffer) - keep
                if emit_len > 0:
                    visible_parts.append(self._buffer[:emit_len])
                    self._buffer = self._buffer[emit_len:]
                break
            if start > 0:
                visible_parts.append(self._buffer[:start])
                self._buffer = self._buffer[start:]
            after_open = len(_ASSISTANT_PROGRESS_OPEN)
            end = self._buffer.find(_ASSISTANT_PROGRESS_CLOSE, after_open)
            if end < 0:
                if final:
                    visible_parts.append(self._buffer)
                    self._buffer = ""
                break
            raw_payload = self._buffer[after_open:end].strip()
            message = _assistant_progress_message(raw_payload)
            if message:
                progress_messages.append(message)
            self._buffer = self._buffer[end + len(_ASSISTANT_PROGRESS_CLOSE):]
        return "".join(visible_parts), progress_messages


def _assistant_progress_message(raw_payload: str) -> str:
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        return ""
    if not isinstance(payload, dict):
        return ""
    message = str(payload.get("message") or payload.get("detail") or "").strip()
    return " ".join(message.split())


def _assistant_progress_prefix_keep(text: str) -> int:
    max_keep = min(len(text), len(_ASSISTANT_PROGRESS_OPEN) - 1)
    for size in range(max_keep, 0, -1):
        if _ASSISTANT_PROGRESS_OPEN.startswith(text[-size:]):
            return size
    return 0


def _strip_assistant_progress_markers(text: str) -> tuple[str, list[str]]:
    return _AssistantProgressFilter().strip(text)


class _AssistantArtifactFilter:
    """Extract same-stream artifact JSON markers from assistant text."""

    def __init__(self) -> None:
        self._buffer = ""

    def feed(self, text: str) -> tuple[str, list[dict[str, Any]]]:
        self._buffer += text
        return self._drain(final=False)

    def flush(self) -> tuple[str, list[dict[str, Any]]]:
        return self._drain(final=True)

    def strip(self, text: str) -> tuple[str, list[dict[str, Any]]]:
        self._buffer = text
        return self._drain(final=True)

    def _drain(self, *, final: bool) -> tuple[str, list[dict[str, Any]]]:
        visible_parts: list[str] = []
        artifacts: list[dict[str, Any]] = []
        while self._buffer:
            start = self._buffer.find(_ASSISTANT_ARTIFACTS_OPEN)
            if start < 0:
                if final:
                    visible_parts.append(self._buffer)
                    self._buffer = ""
                    break
                keep = _assistant_artifacts_prefix_keep(self._buffer)
                emit_len = len(self._buffer) - keep
                if emit_len > 0:
                    visible_parts.append(self._buffer[:emit_len])
                    self._buffer = self._buffer[emit_len:]
                break
            if start > 0:
                visible_parts.append(self._buffer[:start])
                self._buffer = self._buffer[start:]
            after_open = len(_ASSISTANT_ARTIFACTS_OPEN)
            end = self._buffer.find(_ASSISTANT_ARTIFACTS_CLOSE, after_open)
            if end < 0:
                if final:
                    self._buffer = ""
                break
            raw_payload = self._buffer[after_open:end].strip()
            artifacts.extend(_assistant_artifact_items(raw_payload))
            self._buffer = self._buffer[end + len(_ASSISTANT_ARTIFACTS_CLOSE):]
        return "".join(visible_parts), artifacts


def _assistant_artifact_items(raw_payload: str) -> list[dict[str, Any]]:
    try:
        payload = json.loads(raw_payload)
    except json.JSONDecodeError:
        return []
    raw_items: object
    if isinstance(payload, dict):
        raw_items = payload.get("artifacts") or payload.get("files") or []
    else:
        raw_items = payload
    if not isinstance(raw_items, list):
        return []

    artifacts: list[dict[str, Any]] = []
    for item in raw_items:
        if isinstance(item, str):
            artifact = {"path": item}
        elif isinstance(item, dict):
            artifact = item
        else:
            continue
        path = str(artifact.get("path") or artifact.get("file") or "").strip().replace("\\", "/")
        if not path:
            continue
        next_item: dict[str, Any] = {"path": path}
        for key in ("name", "kind", "label", "mime"):
            value = artifact.get(key)
            if isinstance(value, str) and value.strip():
                next_item[key] = value.strip()
        size = artifact.get("size")
        if isinstance(size, int) and size >= 0:
            next_item["size"] = size
        artifacts.append(next_item)
    return artifacts


def _assistant_artifacts_prefix_keep(text: str) -> int:
    max_keep = min(len(text), len(_ASSISTANT_ARTIFACTS_OPEN) - 1)
    for size in range(max_keep, 0, -1):
        if _ASSISTANT_ARTIFACTS_OPEN.startswith(text[-size:]):
            return size
    return 0


def _strip_assistant_artifact_markers(text: str) -> tuple[str, list[dict[str, Any]]]:
    return _AssistantArtifactFilter().strip(text)


def _dedupe_assistant_artifacts(artifacts: list[dict[str, Any]]) -> list[dict[str, Any]]:
    seen: set[str] = set()
    deduped: list[dict[str, Any]] = []
    for artifact in artifacts:
        path = str(artifact.get("path") or "").strip().replace("\\", "/")
        key = path.lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append({**artifact, "path": path})
    return deduped


def _format_file_size(value: object) -> str:
    try:
        size = int(value or 0)
    except (TypeError, ValueError):
        return ""
    if size <= 0:
        return ""
    if size < 1024:
        return f"{size} B"
    if size < 1024 * 1024:
        return f"{size / 1024:.1f} KB"
    return f"{size / 1024 / 1024:.1f} MB"


def _format_client_attachment_note(attachment_refs: list[object]) -> str:
    rows: list[str] = []
    for index, item in enumerate(attachment_refs, start=1):
        path = str(getattr(item, "path", "") or "").strip().replace("\\", "/")
        if not path:
            continue
        name = str(getattr(item, "name", "") or Path(path).name or f"file-{index}").strip()
        media_type = str(getattr(item, "media_type", "") or "").strip()
        size = _format_file_size(getattr(item, "size", 0))
        details = ", ".join(part for part in (media_type, size) if part)
        suffix = f" ({details})" if details else ""
        rows.append(f"- {name}: `{path}`{suffix}")
    if not rows:
        return ""
    return "\n".join(
        [
            "# Client File Attachments",
            "",
            "The user attached local client files. Use these uploaded workspace copies; original client SSD paths are not available.",
            *rows,
        ]
    )


def _format_compose_options_note(options: object | None) -> str:
    if options is None:
        return ""
    output_surface = str(getattr(options, "output_surface", "") or "").strip()
    artifact_action = str(getattr(options, "artifact_action", "") or "").strip()
    length_preset = str(getattr(options, "length_preset", "") or "").strip()
    active_artifact_path = str(getattr(options, "active_artifact_path", "") or "").strip()
    try:
        target_output_tokens = int(getattr(options, "target_output_tokens", 0) or 0)
    except (TypeError, ValueError):
        target_output_tokens = 0
    lines = ["# Compose Options", ""]
    if active_artifact_path and output_surface != "chat":
        lines.extend(
            [
                f"Active preview artifact: `{active_artifact_path}`.",
                "If the user asks to change, update, fix, adjust, tweak, or modify this artifact from chat, preserve the active file as the original and create the next version in the same folder instead of overwriting it. Use the same base name with `_vN` before the extension, treating existing `_vN` and ` vN` files as versions, then edit that new version file.",
            ]
        )
    if output_surface == "chat":
        lines.append("The user selected chat output. Prefer a Markdown answer in the conversation and avoid creating large files unless necessary.")
    elif output_surface == "artifact":
        if artifact_action == "create":
            lines.append("The user selected artifact output and asked to create a new artifact. Save the result under `outputs/` with a meaningful filename.")
        elif artifact_action == "edit":
            target = f" `{active_artifact_path}`" if active_artifact_path else ""
            lines.append(f"The user selected artifact output and asked to edit the active artifact{target}. Inspect the target, then save edits to the next version file rather than overwriting the active artifact.")
        else:
            lines.append("The user selected artifact output. Decide whether to create or edit an artifact, and save meaningful outputs under `outputs/`.")
    elif artifact_action or target_output_tokens:
        if artifact_action == "create":
            lines.append("The user left output surface on auto, but if you create an artifact, prefer creating a new artifact under `outputs/`.")
        elif artifact_action == "edit":
            target = f" `{active_artifact_path}`" if active_artifact_path else ""
            lines.append(f"The user left output surface on auto, but if you edit an artifact, inspect the active artifact{target}, then save edits to the next version file rather than overwriting it.")
        else:
            lines.append("The user left output surface on auto. Apply the following artifact preferences only if you decide to create or edit an artifact.")
    if output_surface != "chat" and target_output_tokens:
        floor_tokens = int(target_output_tokens * 0.8)
        lines.append(
            f"Target artifact content length: about {target_output_tokens:,} tokens. "
            f"Treat this as a length target, not merely an upper cap; aim for roughly 80-105% of it "
            f"(at least about {floor_tokens:,} tokens unless the source material is too thin or the user asks to be concise)."
        )
    if output_surface != "chat" and (length_preset == "extra_long" or target_output_tokens >= 20_000):
        lines.append(
            "The long-report section-merge tool is temporarily disabled. For report-style long artifacts, use the selected model's direct output budget and save one coherent artifact with `write_file` when a file is needed."
        )
    return "\n".join(lines)


def _compose_target_output_tokens(options: object | None) -> int:
    if options is None:
        return 0
    output_surface = str(getattr(options, "output_surface", "") or "").strip()
    if output_surface == "chat":
        return 0
    try:
        return max(0, int(getattr(options, "target_output_tokens", 0) or 0))
    except (TypeError, ValueError):
        return 0


def _compose_model_request_tokens(target_output_tokens: int) -> int:
    if target_output_tokens <= 0:
        return 0
    return max(target_output_tokens, int(target_output_tokens * 1.25))


def _tool_progress_delays(tool_name: str) -> tuple[float, float]:
    if tool_name.lower() == "write_long_report":
        return (_LONG_REPORT_PROGRESS_FIRST_DELAY_SECONDS, _LONG_REPORT_PROGRESS_INTERVAL_SECONDS)
    return (_TOOL_PROGRESS_FIRST_DELAY_SECONDS, _TOOL_PROGRESS_INTERVAL_SECONDS)
_RESTORABLE_TOOL_METADATA_DEFAULTS = {
    "read_file_state": {},
    "invoked_skills": [],
    "async_agent_state": [],
    "async_agent_tasks": [],
    "recent_work_log": [],
    "recent_verified_work": [],
    "recent_tool_failures": [],
    "recent_learned_skills": [],
    "task_focus_state": {
        "goal": "",
        "recent_goals": [],
        "active_artifacts": [],
        "verified_state": [],
        "next_step": "",
    },
    "compact_checkpoints": [],
    "compact_last": None,
    "session_title": "",
    "session_title_source": "",
    "session_title_user_edited": False,
    "workflow_duration_seconds": None,
}


def _swarm_delegation_hint_for_prompt(prompt: str) -> str | None:
    text = prompt.strip()
    if not text or text.startswith("/"):
        return None
    lowered = text.lower()
    explicit_team = any(
        token in lowered
        for token in (
            "ai 팀",
            "ai team",
            "swarm",
            "스웜",
            "팀으로",
            "분담",
            "나눠서",
            "나누어",
            "역할을 나눠",
            "split",
            "delegate",
            "parallel",
        )
    )
    role_split = "조사" in text and "정리" in text and "검토" in text
    if explicit_team or role_split:
        if not is_subagent_invocation_enabled():
            return (
                f"{SUBAGENT_INVOCATION_DISABLED_MESSAGE} "
                "Do not use the `agent` tool or create local-agent tasks; handle the request directly."
            )
        return _SWARM_DELEGATION_HINT
    return None


def _task_duration_seconds(task, *, now: float) -> float:
    started_at = getattr(task, "started_at", None)
    if started_at is None:
        started_at = getattr(task, "created_at", None)
    if started_at is None:
        started_at = now
    ended_at = getattr(task, "ended_at", None)
    if ended_at is None:
        ended_at = now
    return max(0.0, float(ended_at) - float(started_at))


def _task_created_seconds(task, *, now: float) -> float:
    created_at = getattr(task, "created_at", None)
    if created_at is None:
        created_at = getattr(task, "started_at", None)
    if created_at is None:
        created_at = now
    return float(created_at)


def _float_metadata_value(metadata: dict[str, object], key: str) -> float | None:
    value = metadata.get(key)
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _task_last_activity_seconds(task, *, now: float) -> float:
    metadata = getattr(task, "metadata", {}) if isinstance(getattr(task, "metadata", {}), dict) else {}
    candidates = [
        getattr(task, "started_at", None),
        getattr(task, "created_at", None),
        _float_metadata_value(metadata, "last_output_at"),
        _float_metadata_value(metadata, "status_note_updated_at"),
    ]
    output_file = getattr(task, "output_file", None)
    try:
        if output_file is not None and Path(output_file).exists():
            candidates.append(Path(output_file).stat().st_mtime)
    except OSError:
        pass
    numeric = [float(value) for value in candidates if value is not None]
    if not numeric:
        return now
    return max(numeric)


def _current_async_agent_task_ids(metadata: dict[str, object] | None) -> set[str]:
    if not isinstance(metadata, dict):
        return set()
    entries = metadata.get("async_agent_tasks")
    if not isinstance(entries, list):
        return set()
    return {
        task_id
        for entry in entries
        if isinstance(entry, dict)
        for task_id in [str(entry.get("task_id") or "").strip()]
        if task_id
    }


def _filter_current_async_agent_tasks(tasks, task_ids: set[str] | None):
    if task_ids is None:
        return list(tasks)
    return [task for task in tasks if str(getattr(task, "id", "") or "") in task_ids]


def _detect_slow_swarm_teammate(
    tasks,
    *,
    now: float,
    alerted_task_ids: set[str],
    task_ids: set[str] | None = None,
) -> dict[str, object] | None:
    scoped_tasks = _filter_current_async_agent_tasks(tasks, task_ids)
    swarm_tasks = [task for task in scoped_tasks if getattr(task, "type", "") in _SWARM_TASK_TYPES]
    running = [task for task in swarm_tasks if getattr(task, "status", "") == "running"]
    finished = [
        task
        for task in swarm_tasks
        if getattr(task, "status", "") == "completed" and getattr(task, "ended_at", None)
    ]
    if not running or not finished:
        return None

    for task in sorted(running, key=lambda item: _task_created_seconds(item, now=now)):
        task_id = str(getattr(task, "id", "") or "")
        if not task_id or task_id in alerted_task_ids:
            continue
        running_duration = _task_duration_seconds(task, now=now)
        if running_duration < _SWARM_STRAGGLER_MIN_SECONDS:
            continue
        created_at = _task_created_seconds(task, now=now)
        peers = [
            peer
            for peer in finished
            if abs(_task_created_seconds(peer, now=now) - created_at)
            <= _SWARM_STRAGGLER_WAVE_WINDOW_SECONDS
        ]
        if not peers:
            continue
        peer_durations = sorted(_task_duration_seconds(peer, now=now) for peer in peers)
        median_peer_duration = peer_durations[len(peer_durations) // 2]
        if running_duration < max(_SWARM_STRAGGLER_MIN_SECONDS, median_peer_duration * _SWARM_STRAGGLER_PEER_FACTOR):
            continue
        metadata = getattr(task, "metadata", {}) if isinstance(getattr(task, "metadata", {}), dict) else {}
        return {
            "task_id": task_id,
            "agent_id": str(metadata.get("agent_id") or task_id),
            "role": str(metadata.get("agent_role") or getattr(task, "description", "") or task_id),
            "running_seconds": running_duration,
            "peer_seconds": median_peer_duration,
            "peer_count": len(peers),
        }
    return None


def _detect_unresponsive_swarm_teammate(
    tasks,
    *,
    now: float,
    alerted_task_ids: set[str],
    task_ids: set[str] | None = None,
) -> dict[str, object] | None:
    scoped_tasks = _filter_current_async_agent_tasks(tasks, task_ids)
    running = [
        task
        for task in scoped_tasks
        if getattr(task, "type", "") in _SWARM_TASK_TYPES and getattr(task, "status", "") == "running"
    ]
    for task in sorted(running, key=lambda item: _task_created_seconds(item, now=now)):
        task_id = str(getattr(task, "id", "") or "")
        if not task_id or task_id in alerted_task_ids:
            continue
        running_seconds = _task_duration_seconds(task, now=now)
        if running_seconds < _SWARM_NO_PROGRESS_SECONDS:
            continue
        last_activity_at = _task_last_activity_seconds(task, now=now)
        idle_seconds = max(0.0, now - last_activity_at)
        if idle_seconds < _SWARM_NO_PROGRESS_SECONDS:
            continue
        metadata = getattr(task, "metadata", {}) if isinstance(getattr(task, "metadata", {}), dict) else {}
        return {
            "task_id": task_id,
            "agent_id": str(metadata.get("agent_id") or task_id),
            "role": str(metadata.get("agent_role") or getattr(task, "description", "") or task_id),
            "running_seconds": running_seconds,
            "idle_seconds": idle_seconds,
        }
    return None


def _detect_swarm_orchestration_checkpoint(
    tasks,
    *,
    now: float,
    last_checkpoint_at: float,
    task_ids: set[str] | None = None,
) -> dict[str, object] | None:
    if now - last_checkpoint_at < _SWARM_ORCHESTRATION_CHECKPOINT_SECONDS:
        return None
    scoped_tasks = _filter_current_async_agent_tasks(tasks, task_ids)
    swarm_tasks = [task for task in scoped_tasks if getattr(task, "type", "") in _SWARM_TASK_TYPES]
    running = [task for task in swarm_tasks if getattr(task, "status", "") == "running"]
    if not running or len(swarm_tasks) < 2:
        return None
    oldest_running_seconds = max(_task_duration_seconds(task, now=now) for task in running)
    if oldest_running_seconds < _SWARM_ORCHESTRATION_CHECKPOINT_SECONDS:
        return None
    completed = [task for task in swarm_tasks if getattr(task, "status", "") == "completed"]
    running_tasks: list[dict[str, str]] = []
    for task in sorted(running, key=lambda item: _task_created_seconds(item, now=now))[:5]:
        metadata = getattr(task, "metadata", {}) if isinstance(getattr(task, "metadata", {}), dict) else {}
        task_id = str(getattr(task, "id", "") or "")
        running_tasks.append(
            {
                "task_id": task_id,
                "agent_id": str(metadata.get("agent_id") or task_id),
                "role": str(metadata.get("agent_role") or getattr(task, "description", "") or task_id),
            }
        )
    return {
        "running_count": len(running),
        "completed_count": len(completed),
        "oldest_running_seconds": oldest_running_seconds,
        "running_tasks": running_tasks,
    }


def _store_async_agent_completion_payload(metadata: dict[str, object], payload: str) -> None:
    if not payload.strip():
        return
    bucket = metadata.setdefault("async_agent_completion_payloads", [])
    if isinstance(bucket, list):
        bucket.append(payload.strip())


def _peek_async_agent_completion_payloads(metadata: dict[str, object], *, max_items: int = 3, max_chars: int = 2400) -> str:
    bucket = metadata.get("async_agent_completion_payloads", [])
    if not isinstance(bucket, list):
        return ""
    items = [str(item).strip() for item in bucket[-max_items:] if str(item).strip()]
    text = "\n\n".join(items)
    if len(text) <= max_chars:
        return text
    return f"{text[:max_chars - 3]}..."


def _pop_async_agent_completion_payloads(metadata: dict[str, object]) -> str:
    bucket = metadata.pop("async_agent_completion_payloads", [])
    if not isinstance(bucket, list):
        return ""
    return "\n\n".join(str(item).strip() for item in bucket if str(item).strip())


def _swarm_notifications_for_completed_agents(completed: list[dict[str, object]]) -> list[dict[str, object]]:
    now_ms = int(time.time() * 1000)
    notifications: list[dict[str, object]] = []
    for index, entry in enumerate(completed):
        task_id = str(entry.get("task_id") or entry.get("agent_id") or index).strip()
        agent_id = str(entry.get("agent_id") or task_id or "작업자").strip()
        description = str(entry.get("description") or agent_id).strip()
        status = str(entry.get("status") or "").strip()
        if status == "completed":
            level = "info"
            message = f"{description} 완료"
        elif status == "killed":
            level = "warning"
            message = f"{description} 중단됨"
        else:
            level = "warning"
            message = f"{description} 오류"
        notifications.append(
            {
                "id": f"{task_id}:{status or 'done'}",
                "from": agent_id,
                "message": message,
                "timestamp": now_ms,
                "level": level,
            }
        )
    return notifications


_PREMATURE_ASYNC_FINAL_MARKERS = (
    "보고서",
    "최종",
    "결론",
    "요약",
    "분석 결과",
    "종합",
    "recommendation",
    "conclusion",
    "final",
    "report",
)


def _guard_premature_async_agent_final_response(text: str, tool_metadata: dict[str, object] | None) -> str:
    """Suppress report-like final answers while async agents are still pending."""
    if not pending_async_agent_entries(tool_metadata):
        return text
    stripped = text.strip()
    if not stripped:
        return (
            "AI 팀 작업자가 아직 진행 중입니다. 중간 결과를 확인하면서 필요한 정보는 작업자에게 전달하고, "
            "결과가 준비되면 한 번에 취합하겠습니다."
        )
    lowered = stripped.lower()
    looks_final = len(stripped) > 900 or any(marker in lowered for marker in _PREMATURE_ASYNC_FINAL_MARKERS)
    if not looks_final:
        return stripped
    return (
        "AI 팀 작업자가 아직 진행 중이라 최종 산출물은 만들지 않겠습니다. "
        "중간점검으로 작업자 출력과 막힌 지점을 확인하고, 필요한 정보는 `send_message`로 전달한 뒤 "
        "결과가 준비되면 취합하겠습니다."
    )


def _truncate_progress_text(value: object, limit: int = 96) -> str:
    text = " ".join(str(value or "").split())
    if len(text) <= limit:
        return text
    return f"{text[:limit - 3]}..."


def _slugify_progress_report_title(title: object) -> str:
    text = re.sub(r"\s+", "_", str(title or "").strip())
    text = re.sub(r'[<>:"/\\|?*\x00-\x1f]+', "_", text)
    return text.strip("._") or "long_report"


def _long_report_progress_path(payload: dict[str, object]) -> str:
    explicit = str(payload.get("output_path") or "").strip()
    if explicit:
        return explicit
    suffix = ".html" if str(payload.get("output_format") or "").strip().lower() == "html" else ".md"
    return f"outputs/{_slugify_progress_report_title(payload.get('title'))}_report{suffix}"


def _progress_preview_path(tool_name: str, payload: dict[str, object]) -> str:
    lower = tool_name.lower()
    raw_path: object = payload.get("file_path") or payload.get("path")
    if lower == "write_long_report":
        raw_path = raw_path or _long_report_progress_path(payload)
    return str(raw_path or "").strip()


def _looks_like_text_preview_path(path: str) -> bool:
    return Path(path).suffix.lower() in {
        ".html",
        ".htm",
        ".md",
        ".markdown",
        ".txt",
        ".json",
        ".csv",
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".css",
        ".py",
    }


_PROGRESS_PREVIEW_READ_LIMIT = 0
_PROGRESS_PREVIEW_DISPLAY_LIMIT = 0


def _trim_progress_preview_text(text: str, *, limit: int = _PROGRESS_PREVIEW_DISPLAY_LIMIT) -> str:
    value = str(text or "")
    if limit <= 0:
        return value
    if len(value) <= limit:
        return value
    return f"...\n{value[-limit:]}"


def _read_progress_preview_content(cwd: Path, path: str, *, limit: int = _PROGRESS_PREVIEW_READ_LIMIT) -> str:
    clean_path = str(path or "").strip()
    if not clean_path or not _looks_like_text_preview_path(clean_path):
        return ""
    preview_path = Path(clean_path).expanduser()
    if not preview_path.is_absolute():
        preview_path = cwd / preview_path
    try:
        text = preview_path.resolve().read_text(encoding="utf-8", errors="replace")
    except OSError:
        return ""
    if limit <= 0:
        return text
    return text if len(text) <= limit else text[-limit:]


def _progress_preview_content(tool_name: str, cwd: Path, path: str) -> str:
    read_limit = _LONG_REPORT_PROGRESS_READ_LIMIT if tool_name.lower() == "write_long_report" else _PROGRESS_PREVIEW_READ_LIMIT
    display_limit = (
        _LONG_REPORT_PROGRESS_DISPLAY_LIMIT
        if tool_name.lower() == "write_long_report"
        else _PROGRESS_PREVIEW_DISPLAY_LIMIT
    )
    content = _read_progress_preview_content(cwd, path, limit=read_limit)
    if not content:
        return ""
    return _trim_progress_preview_text(content, limit=display_limit)


def _long_report_progress_usage_input(cwd: Path, path: str) -> dict[str, object]:
    state = read_long_report_progress_state(cwd, path)
    return {key: value for key, value in state.items() if _long_report_progress_value_visible(value)}


def _latest_long_report_progress_usage_input(cwd: Path, *, min_mtime: float = 0.0) -> dict[str, object]:
    progress_dir = cwd.resolve() / ".myharness" / "long-report-progress"
    try:
        candidates = [
            path
            for path in progress_dir.glob("*.json")
            if path.is_file() and path.stat().st_mtime >= min_mtime
        ]
    except OSError:
        return {}
    for state_path in sorted(candidates, key=lambda path: path.stat().st_mtime, reverse=True)[:5]:
        try:
            raw = json.loads(state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(raw, dict):
            continue
        output_path = str(raw.get("output_path") or "").strip()
        if not output_path:
            continue
        state = _long_report_progress_usage_input(cwd, output_path)
        if state:
            return state
    return {}


def _long_report_progress_value_visible(value: object) -> bool:
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return value > 0
    if isinstance(value, str):
        return bool(value.strip())
    if isinstance(value, list):
        return bool(value)
    return False


def _tool_progress_message(tool_name: str, tool_input: dict[str, object] | None, elapsed_seconds: int) -> str:
    lower = tool_name.lower()
    payload = tool_input or {}
    if lower == "write_long_report":
        return _long_report_progress_message(payload, elapsed_seconds)
    if "bash" in lower or "shell" in lower:
        command = _truncate_progress_text(payload.get("command"))
        return f"명령 실행 중... {elapsed_seconds}초 경과" + (f" · {command}" if command else "")
    if "write" in lower or "edit" in lower or "notebook" in lower:
        path = _truncate_progress_text(_progress_preview_path(tool_name, payload))
        return f"파일 작업 중... {elapsed_seconds}초 경과" + (f" · {path}" if path else "")
    target = _truncate_progress_text(payload.get("url") or payload.get("query") or payload.get("pattern"))
    return f"{tool_name} 실행 중... {elapsed_seconds}초 경과" + (f" · {target}" if target else "")


def _long_report_progress_message(payload: dict[str, object], elapsed_seconds: int) -> str:
    phase_label = _truncate_progress_text(payload.get("phase_label"), limit=64)
    section_title = _truncate_progress_text(payload.get("section_title"), limit=54)
    section_index = _progress_int(payload.get("section_index"))
    section_total = _progress_int(payload.get("section_total"))
    outline_count = len(payload.get("outline_sections")) if isinstance(payload.get("outline_sections"), list) else 0
    written_tokens = _progress_int(payload.get("document_written_tokens"))
    if section_index and section_total:
        base = f"{section_index}/{section_total} 섹션 작성 중"
    elif phase_label:
        base = phase_label
    elif outline_count:
        base = f"보고서 뼈대 생성 완료 · {outline_count}개 섹션"
    else:
        base = "보고서 뼈대 생성 중"
    parts = [base]
    if section_title:
        parts.append(section_title)
    if written_tokens:
        parts.append(f"작성 {written_tokens:,} 토큰")
    parts.append(f"{elapsed_seconds}초 경과")
    return " · ".join(parts)


def _progress_int(value: object) -> int:
    if isinstance(value, bool):
        return 0
    try:
        number = int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0
    return number if number > 0 else 0


def _normalize_question_choices(choices: list[dict[str, object]]) -> list[dict[str, str]]:
    normalized: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in choices:
        value = str(item.get("value") or "").strip()
        key = value.lower()
        if not value or key in seen:
            continue
        seen.add(key)
        label = str(item.get("label") or value).strip() or value
        description = str(item.get("description") or "").strip()
        normalized.append({"value": value, "label": label, "description": description})
        if len(normalized) >= 6:
            break
    return normalized


def _question_choice_label(answer: str, choices: list[dict[str, str]]) -> str:
    normalized_answer = answer.strip()
    if not normalized_answer:
        return ""
    for choice in choices:
        if choice.get("value", "").strip() == normalized_answer:
            label = choice.get("label", "").strip()
            return label if label and label != normalized_answer else ""
    return ""


def _format_question_answer_transcript(question: str, answer: str, choices: list[dict[str, str]]) -> str:
    question_text = question.strip() or "추가 정보가 필요합니다."
    answer_text = answer.strip()
    parts = [
        "질문",
        question_text,
        "",
        "답변",
        answer_text or "(빈 답변)",
    ]
    choice_label = _question_choice_label(answer_text, choices)
    if choice_label:
        parts.extend(["", "선택지 표시", choice_label])
    return "\n".join(parts)


def _provider_select_options(settings: Settings) -> list[dict[str, object]]:
    statuses = AuthManager(settings).get_profile_statuses()
    hidden_profiles = {"copilot", "moonshot", "minimax"}
    hidden_providers = {"copilot", "moonshot", "minimax"}
    return [
        {
            "value": name,
            "label": info["label"],
            "description": f"{info['provider']} / {info['auth_source']}" + (" [missing auth]" if not info["configured"] else ""),
            "active": info["active"],
        }
        for name, info in statuses.items()
        if name not in hidden_profiles and info["provider"] not in hidden_providers
    ]


def _effort_select_options(settings: Settings) -> list[dict[str, object]]:
    return [
        {"value": "none", "label": "None", "description": "Disable explicit reasoning effort", "active": settings.effort in {"none", "auto", ""}},
        {"value": "low", "label": "Low", "description": "Fastest responses", "active": settings.effort == "low"},
        {"value": "medium", "label": "Medium", "description": "Balanced reasoning", "active": settings.effort == "medium"},
        {"value": "high", "label": "High", "description": "Deepest reasoning", "active": settings.effort == "high"},
        {"value": "xhigh", "label": "XHigh", "description": "Maximum reasoning", "active": settings.effort in {"xhigh", "max"}},
    ]


def _model_select_options(current_model: str, provider: str, allowed_models: list[str] | None = None) -> list[dict[str, object]]:
    provider_name = provider.lower()
    if allowed_models:
        return [
            {
                "value": value,
                "label": value,
                "description": _model_option_description(provider_name, value),
                "active": value == current_model,
            }
            for value in allowed_models
        ]
    if provider_name in {"anthropic", "anthropic_claude"}:
        resolved_current = resolve_model_setting(current_model, provider_name)
        return [
            {
                "value": value,
                "label": label,
                "description": description,
                "active": value == current_model
                or resolve_model_setting(value, provider_name) == resolved_current,
            }
            for value, label, description in CLAUDE_MODEL_ALIAS_OPTIONS
        ]
    families: list[tuple[str, str]] = []
    if provider_name == "pgpt":
        families.extend(
            [
                ("gpt-5.5", _model_option_description(provider_name, "gpt-5.5")),
                ("gpt-5.4", _model_option_description(provider_name, "gpt-5.4")),
                ("gpt-5.4-mini", _model_option_description(provider_name, "gpt-5.4-mini")),
                ("gpt-5.4-nano", _model_option_description(provider_name, "gpt-5.4-nano")),
            ]
        )
    elif provider_name in {"openai_codex", "openai-codex", "openai", "openai-compatible", "openrouter", "github_copilot"}:
        families.extend(
            [
                ("gpt-5.5", "OpenAI flagship"),
                ("gpt-5.4", "Previous GPT-5.4"),
                ("gpt-5.4-mini", _model_option_description(provider_name, "gpt-5.4-mini")),
                ("gpt-5.4-nano", _model_option_description(provider_name, "gpt-5.4-nano")),
                ("gpt-5", "General GPT-5"),
                ("gpt-4.1", "Stable GPT-4.1"),
                ("o4-mini", "Fast reasoning"),
            ]
        )
    elif provider_name in {"moonshot", "moonshot-compatible"}:
        families.extend(
            [
                ("kimi-k2.5", "Moonshot K2.5"),
                ("kimi-k2-turbo-preview", "Faster Moonshot"),
            ]
        )
    elif provider_name == "dashscope":
        families.extend(
            [
                ("qwen3.5-flash", "Fast Qwen"),
                ("qwen3-max", "Strong Qwen"),
                ("deepseek-r1", "Reasoning model"),
            ]
        )
    elif provider_name == "gemini":
        families.extend(
            [
                ("gemini-3.5-flash", "Gemini 3.5 Flash stable"),
                ("gemini-3.1-pro-preview", "Gemini 3.1 Pro preview"),
                ("gemini-3-flash-preview", "Gemini 3 Flash preview"),
                ("gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite stable"),
            ]
        )
    elif provider_name == "minimax":
        families.extend(
            [
                ("MiniMax-M2.7", "MiniMax flagship"),
                ("MiniMax-M2.7-highspeed", "MiniMax fast"),
            ]
        )
    seen: set[str] = set()
    options: list[dict[str, object]] = []
    for value, description in [*families, (current_model, "Current model")]:
        if not value or value in seen:
            continue
        seen.add(value)
        options.append(
            {
                "value": value,
                "label": value,
                "description": description,
                "active": value == current_model,
            }
        )
    return options


def _model_option_description(provider_name: str, model: str) -> str:
    normalized = model.strip().lower()
    if normalized == "gpt-5.5":
        return "Strongest coding and reasoning"
    if normalized == "gpt-5.4":
        return "Balanced default model"
    if normalized == "gpt-5.4-mini":
        return "Faster and lighter"
    if normalized == "gpt-5.4-nano":
        return "Lowest latency"
    if provider_name == "gemini" or normalized.startswith("gemini-"):
        return {
            "gemini-3.5-flash": "Gemini 3.5 Flash stable",
            "gemini-3.1-pro-preview": "Gemini 3.1 Pro preview",
            "gemini-3-flash-preview": "Gemini 3 Flash preview",
            "gemini-3.1-flash-lite": "Gemini 3.1 Flash-Lite stable",
        }.get(normalized, "Gemini model")
    if provider_name == "pgpt":
        return "P-GPT model"
    return "Available model"


@dataclass(frozen=True)
class BackendHostConfig:
    """Configuration for one backend host session."""

    model: str | None = None
    subagent_model: str | None = None
    subagent_effort: str | None = None
    max_turns: int | None = None
    base_url: str | None = None
    system_prompt: str | None = None
    api_key: str | None = None
    api_format: str | None = None
    active_profile: str | None = None
    effort: str | None = None
    api_client: SupportsStreamingMessages | None = None
    cwd: str | None = None
    restore_messages: list[dict] | None = None
    restore_tool_metadata: dict[str, object] | None = None
    restore_usage: dict[str, object] | None = None
    restore_usage_accounting: dict[str, object] | None = None
    enforce_max_turns: bool = True
    permission_mode: str | None = None
    session_backend: SessionBackend | None = None
    extra_skill_dirs: tuple[str, ...] = ()
    extra_plugin_roots: tuple[str, ...] = ()


class ReactBackendHost:
    """Drive the MyHarness runtime over a structured stdin/stdout protocol."""

    def __init__(self, config: BackendHostConfig) -> None:
        self._config = config
        self._bundle = None
        self._write_lock = asyncio.Lock()
        self._request_queue: asyncio.Queue[FrontendRequest] = asyncio.Queue()
        self._steering_queue: asyncio.Queue[str] = asyncio.Queue()
        self._queued_line_queue: asyncio.Queue[str] = asyncio.Queue()
        self._permission_requests: dict[str, asyncio.Future[bool]] = {}
        self._question_requests: dict[str, asyncio.Future[str]] = {}
        self._question_request_details: dict[str, dict[str, object]] = {}
        self._permission_lock = asyncio.Lock()
        self._busy = False
        self._active_request_task: asyncio.Task[bool] | None = None
        self._running = True
        # Track last tool input per name for rich event emission
        self._last_tool_inputs: dict[str, dict] = {}
        self._history_events: list[dict[str, object]] = []
        self._async_agent_monitor_task: asyncio.Task[None] | None = None
        self._swarm_status_monitor_task: asyncio.Task[None] | None = None
        self._swarm_emit_task: asyncio.Task[None] | None = None
        self._task_update_unregister: Callable[[], None] | None = None
        self._swarm_straggler_alerted_task_ids: set[str] = set()
        self._swarm_no_progress_alerted_task_ids: set[str] = set()
        self._swarm_orchestration_last_checkpoint_at = 0.0

    async def run(self) -> int:
        self._bundle = await build_runtime(
            model=self._config.model,
            subagent_model=self._config.subagent_model,
            subagent_effort=self._config.subagent_effort,
            max_turns=self._config.max_turns,
            base_url=self._config.base_url,
            system_prompt=self._config.system_prompt,
            api_key=self._config.api_key,
            api_format=self._config.api_format,
            active_profile=self._config.active_profile,
            effort=self._config.effort,
            api_client=self._config.api_client,
            cwd=self._config.cwd,
            restore_messages=self._config.restore_messages,
            restore_tool_metadata=self._config.restore_tool_metadata,
            restore_usage=self._config.restore_usage,
            restore_usage_accounting=self._config.restore_usage_accounting,
            permission_prompt=self._ask_permission,
            ask_user_prompt=self._ask_question,
            enforce_max_turns=self._config.enforce_max_turns,
            permission_mode=self._config.permission_mode,
            session_backend=self._config.session_backend,
            extra_skill_dirs=self._config.extra_skill_dirs,
            extra_plugin_roots=self._config.extra_plugin_roots,
        )
        await start_runtime(self._bundle)
        ready_event = BackendEvent.ready(
            self._bundle.app_state.get(),
            get_task_manager().list_tasks(),
            [
                {"name": f"/{command.name}", "description": command.description}
                for command in self._bundle.commands.list_commands()
            ],
            self._skill_snapshots(),
            self._plugin_snapshots(),
        )
        ready_event.session_usage = self._bundle.engine.usage_cost_summary()
        await self._emit(ready_event)
        await self._emit(BackendEvent(type="active_session", value=self._bundle.session_id))
        await self._emit(BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[]))
        await self._emit(self._status_snapshot())
        self._register_task_update_listener()
        self._ensure_async_agent_monitor()
        self._ensure_swarm_status_monitor()

        reader = asyncio.create_task(self._read_requests())
        try:
            while self._running:
                request = await self._request_queue.get()
                if request.type == "shutdown":
                    await self._emit(BackendEvent(type="shutdown"))
                    break
                if request.type in ("permission_response", "question_response"):
                    continue
                if request.type == "cancel_current":
                    await self._cancel_current_request()
                    continue
                if request.type == "steer_line":
                    if self._busy:
                        await self._queue_steering_line(request.line or "")
                    else:
                        await self._request_queue.put(FrontendRequest(type="submit_line", line=request.line or ""))
                    continue
                if request.type == "queue_line":
                    if self._busy:
                        await self._queue_line_after_current(request.line or "")
                    else:
                        await self._request_queue.put(
                            FrontendRequest(
                                type="submit_line",
                                line=request.line or "",
                                attachments=request.attachments,
                                attachment_refs=request.attachment_refs,
                                compose_options=request.compose_options,
                            )
                        )
                    continue
                if request.type == "start_new_session":
                    await self._handle_start_new_session(request.value or "")
                    continue
                if request.type == "list_sessions":
                    await self._handle_list_sessions()
                    continue
                if request.type == "delete_session":
                    await self._handle_delete_session(request.value or "")
                    continue
                if request.type == "refresh_skills":
                    self._sync_learning_mode()
                    await self._refresh_mcp_configs()
                    await self._emit(BackendEvent.skills_snapshot(self._skill_snapshots()))
                    await self._emit(self._status_snapshot())
                    continue
                if request.type == "set_skill_enabled":
                    await self._handle_set_skill_enabled(request.value or "", request.enabled)
                    continue
                if request.type == "set_mcp_enabled":
                    await self._handle_set_mcp_enabled(request.value or "", request.enabled)
                    continue
                if request.type == "set_plugin_enabled":
                    await self._handle_set_plugin_enabled(request.value or "", request.enabled)
                    continue
                if request.type == "set_system_prompt":
                    await self._handle_set_system_prompt(request.value or "")
                    continue
                if request.type == "refresh_runtime_settings":
                    await self._handle_refresh_runtime_settings()
                    continue
                if request.type == "update_session_title":
                    await self._handle_update_session_title(request.value or "")
                    continue
                if request.type == "select_command":
                    await self._handle_select_command(request.command or "")
                    continue
                if request.type == "task_output":
                    await self._handle_task_output(request.task_id or "", request.max_bytes or 12000)
                    continue
                if request.type == "task_stop":
                    await self._handle_task_stop(request.task_id or "")
                    continue
                if request.type == "apply_select_command":
                    command = (request.command or "").strip().lstrip("/").lower()
                    if command in {"provider", "model", "subagent_model", "effort", "subagent_effort"}:
                        if self._busy:
                            await self._emit(BackendEvent(type="error", message="Session is busy"))
                            continue
                        await self._apply_select_command(command, request.value or "")
                        continue
                    if self._busy:
                        await self._emit(BackendEvent(type="error", message="Session is busy"))
                        continue
                    self._busy = True
                    try:
                        self._active_request_task = asyncio.create_task(
                            self._apply_select_command(
                                command,
                                request.value or "",
                            )
                        )
                        should_continue = await self._active_request_task
                    except asyncio.CancelledError:
                        should_continue = True
                        await self._emit(
                            BackendEvent(
                                type="transcript_item",
                                item=TranscriptItem(role="system", text="작업을 중단했습니다."),
                            )
                        )
                        await self._emit(self._status_snapshot())
                        await self._emit(BackendEvent(type="line_complete"))
                    finally:
                        self._active_request_task = None
                        self._busy = False
                    if not should_continue:
                        await self._emit(BackendEvent(type="shutdown"))
                        break
                    await self._promote_next_queued_line()
                    continue
                if request.type != "submit_line":
                    await self._emit(BackendEvent(type="error", message=f"Unknown request type: {request.type}"))
                    continue
                if self._busy:
                    await self._emit(BackendEvent(type="error", message="Session is busy"))
                    continue
                line = (request.line or "").strip()
                if not line and not request.attachments and not request.attachment_refs:
                    continue
                await self._refresh_mcp_configs()
                self._busy = True
                try:
                    self._active_request_task = asyncio.create_task(
                        self._process_line(
                            line,
                            transcript_line=request.transcript_line,
                            attachments=request.attachments,
                            attachment_refs=request.attachment_refs,
                            compose_options=request.compose_options,
                            emit_user_transcript=not request.suppress_user_transcript,
                            isolated_context=request.isolated_context,
                        )
                    )
                    should_continue = await self._active_request_task
                except asyncio.CancelledError:
                    should_continue = True
                    await self._emit(
                        BackendEvent(type="transcript_item", item=TranscriptItem(role="system", text="작업을 중단했습니다."))
                    )
                    await self._emit(self._status_snapshot())
                    await self._emit(BackendEvent(type="line_complete"))
                finally:
                    self._active_request_task = None
                    self._busy = False
                if not should_continue:
                    await self._emit(BackendEvent(type="shutdown"))
                    break
                await self._promote_next_queued_line()
        finally:
            self._running = False
            if self._async_agent_monitor_task is not None:
                self._async_agent_monitor_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._async_agent_monitor_task
            if self._swarm_status_monitor_task is not None:
                self._swarm_status_monitor_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._swarm_status_monitor_task
            if self._swarm_emit_task is not None:
                self._swarm_emit_task.cancel()
                with contextlib.suppress(asyncio.CancelledError):
                    await self._swarm_emit_task
            if self._task_update_unregister is not None:
                self._task_update_unregister()
                self._task_update_unregister = None
            reader.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await reader
            if self._bundle is not None:
                await close_runtime(self._bundle)
        return 0

    def _ensure_async_agent_monitor(self) -> None:
        if self._bundle is None:
            return
        metadata = getattr(self._bundle.engine, "tool_metadata", None)
        if not pending_async_agent_entries(metadata):
            return
        if self._async_agent_monitor_task is not None and not self._async_agent_monitor_task.done():
            return
        self._async_agent_monitor_task = asyncio.create_task(self._monitor_async_agents())

    def _register_task_update_listener(self) -> None:
        if self._task_update_unregister is not None:
            return

        def _on_task_update(task) -> None:
            if getattr(task, "type", "") not in _SWARM_TASK_TYPES:
                return
            self._schedule_swarm_status_emit()

        self._task_update_unregister = get_task_manager().register_update_listener(_on_task_update)

    def _schedule_swarm_status_emit(self) -> None:
        if self._bundle is None or not self._running:
            return
        if self._swarm_emit_task is not None and not self._swarm_emit_task.done():
            return
        self._swarm_emit_task = asyncio.create_task(self._emit_swarm_status_after_debounce())

    async def _emit_swarm_status_after_debounce(self) -> None:
        await asyncio.sleep(0.25)
        await self._emit(BackendEvent.tasks_snapshot(get_task_manager().list_tasks()))
        await self._emit(BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[]))
        self._ensure_swarm_status_monitor()

    def _ensure_swarm_status_monitor(self) -> None:
        if self._bundle is None or not self._running:
            return
        if not self._has_running_swarm_teammates():
            return
        if self._swarm_status_monitor_task is not None and not self._swarm_status_monitor_task.done():
            return
        self._swarm_status_monitor_task = asyncio.create_task(self._monitor_swarm_status())

    def _has_running_swarm_teammates(self) -> bool:
        try:
            tasks = get_task_manager().list_tasks()
        except Exception:
            return False
        return any(task.type in _SWARM_TASK_TYPES and task.status == "running" for task in tasks)

    async def _monitor_swarm_status(self) -> None:
        while self._running:
            if not self._has_running_swarm_teammates():
                await self._emit(
                    BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[])
                )
                return
            await asyncio.sleep(_SWARM_STATUS_INTERVAL_SECONDS)
            await self._maybe_steer_swarm_orchestration_checkpoint()
            await self._maybe_probe_unresponsive_swarm_teammate()
            await self._maybe_steer_slow_swarm_teammate()
            await self._emit(
                BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[])
            )

    async def _submit_internal_swarm_steering(self, *, status_message: str, line: str) -> None:
        await self._emit(BackendEvent(type="status", message=status_message))
        internal_line = format_internal_steering_update(line)
        if self._busy:
            await self._steering_queue.put(internal_line)
            return
        await self._request_queue.put(
            FrontendRequest(
                type="submit_line",
                line=(
                    "Internal coordination note for this turn. Use it as execution guidance, "
                    "but do not mention the note itself to the user.\n"
                    f"{line}"
                ),
                suppress_user_transcript=True,
            )
        )

    async def _maybe_steer_swarm_orchestration_checkpoint(self) -> None:
        if self._bundle is None or not self._running:
            return
        metadata = self._bundle.engine.tool_metadata
        task_ids = _current_async_agent_task_ids(metadata)
        if not task_ids:
            return
        now = time.time()
        try:
            tasks = get_task_manager().list_tasks()
        except Exception:
            return
        checkpoint = _detect_swarm_orchestration_checkpoint(
            tasks,
            now=now,
            last_checkpoint_at=self._swarm_orchestration_last_checkpoint_at,
            task_ids=task_ids,
        )
        if checkpoint is None:
            return
        self._swarm_orchestration_last_checkpoint_at = now
        running_labels = ", ".join(
            f"{item['agent_id']} ({item['role']}, task_id={item['task_id']})"
            for item in checkpoint["running_tasks"]
        )
        oldest_minutes = max(1, round(float(checkpoint["oldest_running_seconds"]) / 60))
        completed_payloads = _peek_async_agent_completion_payloads(metadata)
        completed_hint = (
            f"Completed worker payloads already available:\n{completed_payloads}\n"
            if completed_payloads.strip()
            else ""
        )
        relay_hint = (
            "If a completed worker produced facts or constraints that a running peer needs, relay the specific handoff "
            "with `send_message` before deciding whether to replace anyone. "
        )
        line = (
            f"AI team orchestration checkpoint: {checkpoint['running_count']} worker(s) still running, "
            f"{checkpoint['completed_count']} completed, oldest running about {oldest_minutes} minutes. "
            f"Running workers: {running_labels}. {completed_hint}"
            "First inspect useful worker outputs with `task_output` and identify relay candidates. "
            f"{relay_hint}"
            "Then relay handoffs or missing prerequisites with `send_message`, and start any dependent next step that partial "
            "results already unblock. If a worker appears blocked after relay, stop and replace it with a narrower prompt, "
            "spawn a stronger replacement with `model=\"inherit\"`, or finish that slice in the main agent. Do not wait passively."
        )
        await self._submit_internal_swarm_steering(
            status_message="AI 팀 중간점검을 진행합니다.",
            line=line,
        )

    async def _maybe_probe_unresponsive_swarm_teammate(self) -> None:
        if self._bundle is None or not self._running:
            return
        task_ids = _current_async_agent_task_ids(self._bundle.engine.tool_metadata)
        if not task_ids:
            return
        try:
            tasks = get_task_manager().list_tasks()
        except Exception:
            return
        silent = _detect_unresponsive_swarm_teammate(
            tasks,
            now=time.time(),
            alerted_task_ids=self._swarm_no_progress_alerted_task_ids,
            task_ids=task_ids,
        )
        if silent is None:
            return
        task_id = str(silent["task_id"])
        self._swarm_no_progress_alerted_task_ids.add(task_id)
        idle_minutes = max(1, round(float(silent["idle_seconds"]) / 60))
        running_minutes = max(1, round(float(silent["running_seconds"]) / 60))
        line = (
            f"AI team worker {silent['agent_id']} ({silent['role']}, task_id={task_id}) "
            f"has been running for about {running_minutes} minutes with no visible output or `task_update` "
            f"status for about {idle_minutes} minutes. First inspect its latest output with `task_output` and infer whether "
            "it is still making progress from existing evidence. Do not send a reminder just to get a status update. "
            "Use `send_message` only if the existing output suggests a concrete missing prerequisite, blocker, or relayable "
            "handoff question. If it still has no useful progress after the next checkpoint, stop and replace it with a narrower prompt, "
            "spawn a stronger replacement with `model=\"inherit\"`, or take over that slice in the main agent."
        )
        await self._submit_internal_swarm_steering(
            status_message="AI 팀 작업자 무응답을 점검합니다.",
            line=line,
        )

    async def _maybe_steer_slow_swarm_teammate(self) -> None:
        if self._bundle is None or not self._running:
            return
        task_ids = _current_async_agent_task_ids(self._bundle.engine.tool_metadata)
        if not task_ids:
            return
        try:
            tasks = get_task_manager().list_tasks()
        except Exception:
            return
        slow = _detect_slow_swarm_teammate(
            tasks,
            now=time.time(),
            alerted_task_ids=self._swarm_straggler_alerted_task_ids,
            task_ids=task_ids,
        )
        if slow is None:
            return
        task_id = str(slow["task_id"])
        self._swarm_straggler_alerted_task_ids.add(task_id)
        running_minutes = max(1, round(float(slow["running_seconds"]) / 60))
        peer_minutes = max(1, round(float(slow["peer_seconds"]) / 60))
        line = (
            f"AI team worker {slow['agent_id']} ({slow['role']}, task_id={task_id}) "
            f"has been running for about {running_minutes} minutes, while {slow['peer_count']} peer worker(s) "
            f"from the same wave finished around {peer_minutes} minutes. "
            "Briefly inspect its latest output and the completed peer outputs. Relay any missing prerequisite with `send_message` "
            "if that can unblock it. If it is not clearly making fresh progress, use "
            f"`task_stop(task_id=\"{task_id}\")`, then either spawn a narrower replacement, spawn a stronger replacement with "
            "`model=\"inherit\"`, or complete the remaining slice in the main agent. Do not keep waiting on one lagging worker."
        )
        await self._submit_internal_swarm_steering(
            status_message="느린 AI 팀 작업자를 감지했습니다.",
            line=line,
        )

    async def _monitor_async_agents(self) -> None:
        assert self._bundle is not None
        metadata = self._bundle.engine.tool_metadata
        while self._running:
            if not pending_async_agent_entries(metadata):
                return
            completed = await wait_for_completed_async_agent_entries(metadata)
            notification_payload = format_completed_task_notifications(completed)
            if not notification_payload.strip():
                return
            _store_async_agent_completion_payload(metadata, notification_payload)
            notifications = _swarm_notifications_for_completed_agents(completed)
            await self._emit(BackendEvent(type="status", message="AI 팀 작업자 결과를 반영했습니다."))
            await self._emit(
                BackendEvent(
                    type="swarm_status",
                    swarm_teammates=self._swarm_teammate_snapshots(),
                    swarm_notifications=notifications,
                )
            )
            if pending_async_agent_entries(metadata):
                continue
            final_payload = _pop_async_agent_completion_payloads(metadata)
            if not final_payload.strip():
                return
            await self._emit(BackendEvent(type="status", message="AI 팀 결과를 한 번에 취합합니다."))
            await self._request_queue.put(
                FrontendRequest(type="submit_line", line=final_payload, suppress_user_transcript=True)
            )
            return

    async def _cancel_current_request(self) -> None:
        task = self._active_request_task
        if task is None or task.done():
            return
        task.cancel()

    async def _queue_steering_line(self, line: str) -> None:
        text = line.strip()
        if not text:
            return
        await self._steering_queue.put(text)
        await self._emit(
            BackendEvent(type="transcript_item", item=TranscriptItem(role="user", text=text, kind="steering"))
        )

    async def _queue_line_after_current(self, line: str) -> None:
        text = line.strip()
        if not text:
            return
        await self._queued_line_queue.put(text)
        await self._emit(
            BackendEvent(type="transcript_item", item=TranscriptItem(role="user", text=text, kind="queued"))
        )
        await self._emit(BackendEvent(type="status", message="다음 질문을 대기열에 추가했습니다."))

    async def _promote_next_queued_line(self) -> None:
        if self._queued_line_queue.empty():
            if self._steering_queue.empty():
                return
            line = self._steering_queue.get_nowait()
            await self._emit(BackendEvent(type="status", message="스티어링 요청을 후속 질문으로 전송합니다."))
        else:
            line = self._queued_line_queue.get_nowait()
            await self._emit(BackendEvent(type="status", message="대기열 질문을 전송합니다."))
        await self._request_queue.put(
            FrontendRequest(type="submit_line", line=line, suppress_user_transcript=True)
        )

    async def _drain_steering_lines(self) -> list[str]:
        lines: list[str] = []
        while not self._steering_queue.empty():
            lines.append(self._steering_queue.get_nowait())
        return lines

    async def _read_requests(self) -> None:
        while True:
            raw = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not raw:
                await self._request_queue.put(FrontendRequest(type="shutdown"))
                return
            payload = raw.decode("utf-8").strip()
            if not payload:
                continue
            try:
                request = FrontendRequest.model_validate_json(payload)
            except Exception as exc:  # pragma: no cover - defensive protocol handling
                await self._emit(BackendEvent(type="error", message=f"Invalid request: {exc}"))
                continue
            if request.type == "permission_response" and request.request_id in self._permission_requests:
                future = self._permission_requests[request.request_id]
                if not future.done():
                    future.set_result(bool(request.allowed))
                continue
            if request.type == "question_response" and request.request_id in self._question_requests:
                future = self._question_requests[request.request_id]
                detail = self._question_request_details.get(request.request_id, {})
                choices = detail.get("choices")
                await self._emit(
                    BackendEvent(
                        type="transcript_item",
                        item=TranscriptItem(
                            role="user",
                            text=_format_question_answer_transcript(
                                str(detail.get("question") or ""),
                                request.answer or "",
                                choices if isinstance(choices, list) else [],
                            ),
                            kind="question_answer",
                        ),
                    )
                )
                if not future.done():
                    future.set_result(request.answer or "")
                continue
            if request.type == "cancel_current":
                await self._cancel_current_request()
                continue
            if request.type == "task_output":
                await self._handle_task_output(request.task_id or "", request.max_bytes or 12000)
                continue
            if request.type == "steer_line":
                if self._busy:
                    await self._queue_steering_line(request.line or "")
                else:
                    await self._request_queue.put(FrontendRequest(type="submit_line", line=request.line or ""))
                continue
            if request.type == "queue_line":
                if self._busy:
                    await self._queue_line_after_current(request.line or "")
                else:
                        await self._request_queue.put(
                            FrontendRequest(
                                type="submit_line",
                                line=request.line or "",
                                attachments=request.attachments,
                                attachment_refs=request.attachment_refs,
                                compose_options=request.compose_options,
                            )
                        )
                continue
            await self._request_queue.put(request)

    async def _process_line(
        self,
        line: str,
        *,
        transcript_line: str | None = None,
        attachments=None,
        attachment_refs=None,
        compose_options=None,
        quiet: bool = False,
        emit_user_transcript: bool = True,
        isolated_context: bool = False,
    ) -> bool:
        assert self._bundle is not None
        attachments = attachments or []
        attachment_refs = attachment_refs or []
        image_blocks: list[ImageBlock] = []
        for item in attachments:
            media_type = str(getattr(item, "media_type", "") or getattr(item, "mediaType", "") or "").strip()
            data = str(getattr(item, "data", "") or "").strip()
            name = str(getattr(item, "name", "") or "")
            if media_type.startswith("image/") and data:
                image_blocks.append(ImageBlock(media_type=media_type, data=data, source_path=name))
        client_attachment_refs = [
            item
            for item in attachment_refs
            if str(getattr(item, "path", "") or "").strip()
        ]
        prompt_notes = [
            note
            for note in (
                _format_client_attachment_note(client_attachment_refs),
                _format_compose_options_note(compose_options),
            )
            if note
        ]
        is_shell_shortcut = not image_blocks and not client_attachment_refs and line.lstrip().startswith("!")
        selected_mcp = None if image_blocks or is_shell_shortcut else self._parse_forced_mcp_line(line)
        if selected_mcp is None and not image_blocks and not is_shell_shortcut:
            selected_mcp = self._parse_forced_mcp_routed_skill_line(line)
        if selected_mcp is not None:
            await self._ensure_forced_mcp_available(selected_mcp[0])
        effective_line = line if image_blocks or is_shell_shortcut else self._line_with_forced_skill(line)
        if prompt_notes and not is_shell_shortcut:
            effective_line = "\n\n".join(part for part in (effective_line.strip(), *prompt_notes) if part)
        effective_prompt: str | ConversationMessage = effective_line
        if image_blocks:
            content = []
            image_note = (
                f"\n\n[Attached image count: {len(image_blocks)}. "
                "Use the attached image content directly when answering.]"
            )
            text_with_note = f"{effective_line.strip()}{image_note}" if effective_line.strip() else image_note.strip()
            content.append(TextBlock(text=text_with_note))
            content.extend(image_blocks)
            effective_prompt = ConversationMessage.from_user_content(content)
        transcript_text = transcript_line or line
        if image_blocks:
            suffix = f" [image attachments: {len(image_blocks)}]"
            transcript_text = f"{transcript_text}{suffix}" if transcript_text else suffix.strip()
        if client_attachment_refs:
            names = ", ".join(
                str(getattr(item, "name", "") or Path(str(getattr(item, "path", ""))).name)
                for item in client_attachment_refs
            )
            suffix = f" [file attachments: {names or len(client_attachment_refs)}]"
            transcript_text = f"{transcript_text}{suffix}" if transcript_text else suffix.strip()
        first_token = (line.strip().split(maxsplit=1) or [""])[0].lower()
        if not attachments and not attachment_refs and first_token == "/help":
            return await self._emit_command_help_modal(line)
        is_internal_task_notification = (
            not emit_user_transcript
            and isinstance(effective_prompt, str)
            and effective_line.lstrip().startswith("<task-notification>")
        )
        if not quiet and emit_user_transcript:
            await self._emit(
                BackendEvent(type="transcript_item", item=TranscriptItem(role="user", text=transcript_text))
            )
        elif not quiet and not is_shell_shortcut and not is_internal_task_notification and transcript_text.strip():
            self._record_history_event(
                BackendEvent(type="transcript_item", item=TranscriptItem(role="user", text=transcript_text))
            )
        if not image_blocks and not is_shell_shortcut and isinstance(effective_prompt, str) and not is_internal_task_notification:
            swarm_hint = _swarm_delegation_hint_for_prompt(effective_line)
            if swarm_hint:
                await self._steering_queue.put(format_internal_steering_update(swarm_hint))
                await self._emit(BackendEvent(type="status", message="역할을 나눠 진행하겠습니다."))

        async def _print_system(message: str) -> None:
            if quiet:
                return
            await self._emit(
                BackendEvent(type="transcript_item", item=TranscriptItem(role="system", text=message))
            )

        tool_progress_tasks: dict[str, asyncio.Task[None]] = {}
        assistant_progress_filter = _AssistantProgressFilter()
        assistant_progress_seen: set[str] = set()
        assistant_artifact_filter = _AssistantArtifactFilter()
        assistant_artifacts: list[dict[str, Any]] = []
        turn_usage_start = copy.deepcopy(self._bundle.engine.usage_accounting)

        async def _emit_assistant_progress(messages: list[str]) -> None:
            for message in messages:
                if message in assistant_progress_seen:
                    continue
                assistant_progress_seen.add(message)
                await self._emit(BackendEvent(type="status", message=message))

        def _tool_progress_key(tool_name: str, tool_call_id: str | None, tool_call_index: int | None) -> str:
            if tool_call_id:
                return tool_call_id
            if tool_call_index is not None:
                return f"{tool_name}:{tool_call_index}"
            return tool_name

        async def _tool_progress_loop(
            tool_name: str,
            tool_input: dict[str, object] | None,
            tool_call_id: str | None,
            tool_call_index: int | None,
        ) -> None:
            assert self._bundle is not None
            cwd = self._bundle.cwd
            started_at = time.monotonic()
            started_wall_time = time.time()
            first_delay, interval = _tool_progress_delays(tool_name)
            await asyncio.sleep(first_delay)
            while True:
                elapsed = max(1, round(time.monotonic() - started_at))
                progress_input = dict(tool_input or {})
                preview_path = _progress_preview_path(tool_name, progress_input)
                if tool_name.lower() == "write_long_report":
                    progress_usage = _long_report_progress_usage_input(cwd, preview_path) if preview_path else {}
                    if not progress_usage:
                        progress_usage = _latest_long_report_progress_usage_input(
                            cwd,
                            min_mtime=max(0.0, started_wall_time - 5.0),
                        )
                    if progress_usage:
                        progress_input.update(progress_usage)
                        preview_path = str(progress_input.get("output_path") or preview_path).strip()
                    else:
                        progress_input.setdefault("phase", "outline")
                        progress_input.setdefault("phase_label", "보고서 뼈대 생성 중")
                if preview_path and "content" not in progress_input:
                    preview_content = _progress_preview_content(tool_name, cwd, preview_path)
                    if preview_content:
                        progress_input.setdefault("path", preview_path)
                        progress_input.setdefault("content", preview_content)
                await self._emit(
                    BackendEvent(
                        type="tool_progress",
                        tool_name=tool_name,
                        tool_call_id=tool_call_id,
                        tool_call_index=tool_call_index,
                        tool_input=progress_input,
                        message=_tool_progress_message(tool_name, progress_input, elapsed),
                    )
                )
                await asyncio.sleep(interval)

        def _start_tool_progress(
            tool_name: str,
            tool_input: dict[str, object] | None,
            tool_call_id: str | None,
            tool_call_index: int | None,
        ) -> None:
            task = asyncio.create_task(_tool_progress_loop(tool_name, tool_input, tool_call_id, tool_call_index))
            tool_progress_tasks[_tool_progress_key(tool_name, tool_call_id, tool_call_index)] = task

        async def _stop_tool_progress(tool_name: str, tool_call_id: str | None, tool_call_index: int | None) -> None:
            task = tool_progress_tasks.pop(_tool_progress_key(tool_name, tool_call_id, tool_call_index), None)
            if not task:
                return
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        async def _stop_all_tool_progress() -> None:
            tasks = list(tool_progress_tasks.values())
            tool_progress_tasks.clear()
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)

        assistant_delta_buffer: list[str] = []
        assistant_delta_flush_task: asyncio.Task[None] | None = None

        def _has_pending_async_agents_for_current_session() -> bool:
            if self._bundle is None:
                return False
            return bool(pending_async_agent_entries(self._bundle.engine.tool_metadata))

        async def _cancel_assistant_delta_flush_task() -> None:
            nonlocal assistant_delta_flush_task
            task = assistant_delta_flush_task
            assistant_delta_flush_task = None
            if task is None or task.done() or task is asyncio.current_task():
                return
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)

        async def _flush_buffered_assistant_delta(*, cancel_scheduled: bool = True) -> None:
            nonlocal assistant_delta_flush_task
            if cancel_scheduled:
                await _cancel_assistant_delta_flush_task()
            else:
                assistant_delta_flush_task = None
            if _has_pending_async_agents_for_current_session() or not assistant_delta_buffer:
                return
            text = "".join(assistant_delta_buffer)
            assistant_delta_buffer.clear()
            if text:
                await self._emit(BackendEvent(type="assistant_delta", message=text))

        async def _delayed_assistant_delta_flush() -> None:
            try:
                await asyncio.sleep(_ASSISTANT_DELTA_FLUSH_INTERVAL_SECONDS)
                await _flush_buffered_assistant_delta(cancel_scheduled=False)
            except asyncio.CancelledError:
                raise

        def _schedule_assistant_delta_flush() -> None:
            nonlocal assistant_delta_flush_task
            if assistant_delta_flush_task is not None and not assistant_delta_flush_task.done():
                return
            assistant_delta_flush_task = asyncio.create_task(_delayed_assistant_delta_flush())

        async def _emit_or_buffer_assistant_delta(text: str) -> None:
            if not text:
                return
            assistant_delta_buffer.append(text)
            if _has_pending_async_agents_for_current_session():
                return
            _schedule_assistant_delta_flush()

        async def _render_event(event: StreamEvent) -> None:
            if isinstance(event, AssistantTextDelta):
                visible_text, progress_messages = assistant_progress_filter.feed(event.text)
                await _emit_assistant_progress(progress_messages)
                visible_text, artifact_items = assistant_artifact_filter.feed(visible_text)
                assistant_artifacts.extend(artifact_items)
                if visible_text:
                    await _emit_or_buffer_assistant_delta(visible_text)
                return
            if isinstance(event, ToolInputDelta):
                await _flush_buffered_assistant_delta()
                await self._emit(
                    BackendEvent(
                        type="tool_input_delta",
                        tool_call_index=event.index,
                        tool_name=event.name,
                        arguments_delta=event.arguments_delta,
                    )
                )
                return
            if isinstance(event, CompactProgressEvent):
                await _flush_buffered_assistant_delta()
                await self._emit(
                    BackendEvent(
                        type="compact_progress",
                        compact_phase=event.phase,
                        compact_trigger=event.trigger,
                        attempt=event.attempt,
                        compact_checkpoint=event.checkpoint,
                        compact_metadata=event.metadata,
                        message=event.message,
                    )
                )
                return
            if isinstance(event, AssistantTurnComplete):
                remaining_text, progress_messages = assistant_progress_filter.flush()
                await _emit_assistant_progress(progress_messages)
                remaining_text, artifact_items = assistant_artifact_filter.feed(remaining_text)
                assistant_artifacts.extend(artifact_items)
                remaining_text, artifact_items = assistant_artifact_filter.flush()
                assistant_artifacts.extend(artifact_items)
                if remaining_text:
                    await _emit_or_buffer_assistant_delta(remaining_text)
                complete_text, complete_progress_messages = _strip_assistant_progress_markers(event.message.text.strip())
                await _emit_assistant_progress(complete_progress_messages)
                complete_text, complete_artifacts = _strip_assistant_artifact_markers(complete_text)
                assistant_artifacts.extend(complete_artifacts)
                assert self._bundle is not None
                pending_agents = _has_pending_async_agents_for_current_session()
                complete_text = _guard_premature_async_agent_final_response(
                    complete_text.strip(),
                    self._bundle.engine.tool_metadata,
                )
                if not pending_agents:
                    await _flush_buffered_assistant_delta()
                else:
                    await _cancel_assistant_delta_flush_task()
                    assistant_delta_buffer.clear()
                is_final_answer = not bool(event.message.tool_uses)
                usage_payload = None
                session_usage_payload = None
                if is_final_answer:
                    turn_accounting = usage_accounting_delta(
                        self._bundle.engine.usage_accounting,
                        turn_usage_start,
                    )
                    usage_payload = self._bundle.engine.usage_cost_summary(turn_accounting)
                    session_usage_payload = self._bundle.engine.usage_cost_summary()
                await self._emit(
                    BackendEvent(
                        type="assistant_complete",
                        message=complete_text.strip(),
                        item=TranscriptItem(role="assistant", text=complete_text.strip()),
                        has_tool_uses=bool(event.message.tool_uses),
                        artifacts=_dedupe_assistant_artifacts(assistant_artifacts),
                        usage=usage_payload,
                        session_usage=session_usage_payload,
                    )
                )
                await self._emit(BackendEvent.tasks_snapshot(get_task_manager().list_tasks()))
                await self._emit(BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[]))
                self._ensure_swarm_status_monitor()
                return
            if isinstance(event, ToolExecutionStarted):
                await _flush_buffered_assistant_delta()
                self._last_tool_inputs[event.tool_name] = event.tool_input or {}
                _start_tool_progress(event.tool_name, event.tool_input or {}, event.tool_use_id, event.index)
                await self._emit(
                    BackendEvent(
                        type="tool_started",
                        tool_name=event.tool_name,
                        tool_call_id=event.tool_use_id,
                        tool_call_index=event.index,
                        tool_input=event.tool_input,
                        item=TranscriptItem(
                            role="tool",
                            text=f"{event.tool_name} {json.dumps(event.tool_input, ensure_ascii=True)}",
                            tool_name=event.tool_name,
                            tool_input=event.tool_input,
                        ),
                    )
                )
                return
            if isinstance(event, ToolExecutionCompleted):
                await _flush_buffered_assistant_delta()
                await _stop_tool_progress(event.tool_name, event.tool_use_id, event.index)
                await self._emit(
                    BackendEvent(
                        type="tool_completed",
                        tool_name=event.tool_name,
                        tool_call_id=event.tool_use_id,
                        tool_call_index=event.index,
                        output=event.output,
                        is_error=event.is_error,
                        item=TranscriptItem(
                            role="tool_result",
                            text=event.output,
                            tool_name=event.tool_name,
                            is_error=event.is_error,
                        ),
                    )
                )
                await self._emit(BackendEvent.tasks_snapshot(get_task_manager().list_tasks()))
                await self._emit(BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[]))
                self._ensure_swarm_status_monitor()
                await self._emit(self._status_snapshot())
                # Emit todo_update when TodoWrite tool runs
                if event.tool_name in ("TodoWrite", "todo_write"):
                    tool_input = self._last_tool_inputs.get(event.tool_name, {})
                    await self._emit_todo_update(tool_input, event.output)
                # Emit plan_mode_change when plan-related tools complete
                if event.tool_name in ("set_permission_mode", "plan_mode"):
                    assert self._bundle is not None
                    new_mode = self._bundle.app_state.get().permission_mode
                    await self._emit(BackendEvent(type="plan_mode_change", plan_mode=new_mode))
                if event.transcript_output:
                    await self._emit(
                        BackendEvent(
                            type="transcript_item",
                            item=TranscriptItem(role="assistant", text=event.transcript_output),
                        )
                    )
                return
            if isinstance(event, ErrorEvent):
                await _flush_buffered_assistant_delta()
                await self._emit(BackendEvent(type="error", message=event.message))
                if not quiet:
                    await self._emit(
                        BackendEvent(
                            type="transcript_item",
                            item=TranscriptItem(role="system", text=event.message),
                        )
                    )
                return
            if isinstance(event, StatusEvent):
                await _flush_buffered_assistant_delta()
                await self._emit(BackendEvent(type="status", message=event.message))
                return

        async def _clear_output() -> None:
            await self._emit(BackendEvent(type="clear_transcript"))

        started_at = time.monotonic()
        original_messages = self._bundle.engine.messages if isolated_context else None
        original_conversation_state = (
            copy.deepcopy(self._bundle.engine.tool_metadata.get("conversation_state"))
            if isolated_context
            else None
        )
        original_max_tokens = self._bundle.engine.max_tokens
        original_tool_registry = self._bundle.tool_registry
        original_engine_tool_registry = getattr(self._bundle.engine, "_tool_registry", None)
        selected_mcp_registry = (
            self._tool_registry_for_selected_mcp(selected_mcp[0])
            if selected_mcp is not None
            else None
        )
        selected_mcp_metadata_keys = (
            "selected_mcp_server",
            "selected_mcp_tool_calls",
            "selected_mcp_not_found_count",
            "selected_mcp_success_count",
        )
        target_output_tokens = _compose_target_output_tokens(compose_options)
        target_metadata_keys = (
            "compose_target_output_tokens",
            "compose_target_output_floor_tokens",
            "compose_active_artifact_path",
            "compose_artifact_action",
            "compose_artifact_versioning",
        )
        original_target_metadata = {
            key: self._bundle.engine.tool_metadata.get(key)
            for key in target_metadata_keys
            if key in self._bundle.engine.tool_metadata
        }
        max_tokens_changed = False
        try:
            if target_output_tokens:
                self._bundle.engine.tool_metadata["compose_target_output_tokens"] = target_output_tokens
                self._bundle.engine.tool_metadata["compose_target_output_floor_tokens"] = int(target_output_tokens * 0.8)
                self._bundle.engine.set_max_tokens(_compose_model_request_tokens(target_output_tokens))
                max_tokens_changed = True
            active_artifact_path = str(getattr(compose_options, "active_artifact_path", "") or "").strip()
            if active_artifact_path:
                self._bundle.engine.tool_metadata["compose_active_artifact_path"] = active_artifact_path
                self._bundle.engine.tool_metadata["compose_artifact_action"] = str(
                    getattr(compose_options, "artifact_action", "") or "auto"
                )
                self._bundle.engine.tool_metadata["compose_artifact_versioning"] = True
            if (
                first_token != "/clear"
                and not first_token.startswith("/")
                and not quiet
                and not is_internal_task_notification
            ):
                await self._maybe_update_session_title_from_prompt(transcript_text)
            handle_line_kwargs = {
                "print_system": _print_system,
                "render_event": _render_event,
                "clear_output": _clear_output,
            }
            if "steering_provider" in inspect.signature(handle_line).parameters:
                handle_line_kwargs["steering_provider"] = self._drain_steering_lines
            if original_messages is not None:
                self._bundle.engine.clear()
            try:
                if selected_mcp_registry is not None:
                    self._bundle.engine.tool_metadata["selected_mcp_server"] = selected_mcp[0]
                    self._bundle.engine.tool_metadata["selected_mcp_tool_calls"] = 0
                    self._bundle.engine.tool_metadata["selected_mcp_not_found_count"] = 0
                    self._bundle.engine.tool_metadata["selected_mcp_success_count"] = 0
                    self._bundle.tool_registry = selected_mcp_registry
                    setattr(self._bundle.engine, "_tool_registry", selected_mcp_registry)
                should_continue = await handle_line(
                    self._bundle,
                    effective_prompt,
                    **handle_line_kwargs,
                )
            except BaseException:
                if original_messages is not None:
                    self._bundle.engine.load_messages(original_messages)
                    if original_conversation_state is None:
                        self._bundle.engine.tool_metadata.pop("conversation_state", None)
                    else:
                        self._bundle.engine.tool_metadata["conversation_state"] = original_conversation_state
                raise
            await _flush_buffered_assistant_delta()
            if original_messages is not None:
                isolated_messages = self._bundle.engine.messages
                visible_messages = []
                if transcript_text.strip():
                    visible_messages.append(ConversationMessage.from_user_text(transcript_text))
                visible_messages.extend(message for message in isolated_messages if message.role != "user")
                self._bundle.engine.load_messages([*original_messages, *visible_messages])
                if original_conversation_state is None:
                    self._bundle.engine.tool_metadata.pop("conversation_state", None)
                else:
                    self._bundle.engine.tool_metadata["conversation_state"] = original_conversation_state
            workflow_duration_seconds = max(1, round(time.monotonic() - started_at))
            workflow_duration_metadata = {"workflow_duration_seconds": workflow_duration_seconds}
            self._bundle.engine.tool_metadata["workflow_duration_seconds"] = workflow_duration_seconds
            self._record_history_event(BackendEvent(type="line_complete", compact_metadata=workflow_duration_metadata))
            if first_token != "/clear" and not quiet:
                self._save_current_session_snapshot()
            await self._emit(self._status_snapshot())
            await self._emit(BackendEvent.tasks_snapshot(get_task_manager().list_tasks()))
            self._ensure_swarm_status_monitor()
            if first_token == "/clear":
                session_id = self._start_new_saved_session()
                self._save_empty_session_snapshot("새 채팅")
                await self._emit(BackendEvent(type="active_session", value=session_id))
                await self._handle_list_sessions()
            elif first_token == "/resume":
                parts = line.strip().split(maxsplit=1)
                if len(parts) > 1 and parts[1].strip():
                    self._set_saved_session_id(parts[1].strip().split()[0])
            if first_token in {"/reload-plugins", "/skills"}:
                await self._emit(BackendEvent.skills_snapshot(self._skill_snapshots()))
            self._ensure_async_agent_monitor()
            if first_token != "/clear" and not quiet and not is_internal_task_notification:
                await self._maybe_update_session_title()
            await self._emit(
                BackendEvent(
                    type="line_complete",
                    quiet=quiet,
                    compact_metadata=workflow_duration_metadata,
                )
            )
            return should_continue
        finally:
            if max_tokens_changed:
                self._bundle.engine.set_max_tokens(original_max_tokens)
            for key in target_metadata_keys:
                if key in original_target_metadata:
                    self._bundle.engine.tool_metadata[key] = original_target_metadata[key]
                else:
                    self._bundle.engine.tool_metadata.pop(key, None)
            self._bundle.tool_registry = original_tool_registry
            if original_engine_tool_registry is not None:
                setattr(self._bundle.engine, "_tool_registry", original_engine_tool_registry)
            for key in selected_mcp_metadata_keys:
                self._bundle.engine.tool_metadata.pop(key, None)
            await _stop_all_tool_progress()
            await _cancel_assistant_delta_flush_task()
            release_mutation_lock(self._bundle.engine.tool_metadata.pop("mutation_lock_token", None))

    async def _emit_command_help_modal(self, line: str) -> bool:
        assert self._bundle is not None
        parsed = self._bundle.commands.lookup(line) or self._bundle.commands.lookup("/help")
        if parsed is None:
            await self._emit(BackendEvent(type="error", message="도움말 명령을 찾을 수 없습니다."))
            await self._emit(self._status_snapshot())
            await self._emit(BackendEvent(type="line_complete", quiet=True))
            return True
        command, args = parsed
        result = await command.handler(
            args,
            CommandContext(
                engine=self._bundle.engine,
                hooks_summary=self._bundle.hook_summary(),
                mcp_summary=self._bundle.mcp_summary(),
                plugin_summary=self._bundle.plugin_summary(),
                cwd=self._bundle.cwd,
                tool_registry=self._bundle.tool_registry,
                app_state=self._bundle.app_state,
                session_backend=self._bundle.session_backend,
                session_id=self._bundle.session_id,
                extra_skill_dirs=self._bundle.extra_skill_dirs,
                extra_plugin_roots=self._bundle.extra_plugin_roots,
            ),
        )
        if result.refresh_runtime:
            refresh_runtime_client(self._bundle)
        await self._emit(
            BackendEvent(
                type="modal_request",
                modal={
                    "kind": "command_help",
                    "title": "명령어",
                    "text": result.message or "",
                },
            )
        )
        await self._emit(self._status_snapshot())
        await self._emit(BackendEvent(type="line_complete", quiet=True))
        return not result.should_exit

    async def _maybe_update_session_title_from_prompt(self, user_text: str) -> None:
        assert self._bundle is not None
        metadata = self._bundle.engine.tool_metadata
        if str(metadata.get("session_title") or "").strip():
            return
        clean_user_text = user_text.strip()
        if not clean_user_text:
            return
        title = fallback_session_title_from_user_text(clean_user_text)
        if not title:
            return
        metadata["session_title"] = title
        metadata["session_title_source"] = _SESSION_TITLE_SOURCE_PROMPT
        await self._emit(BackendEvent(type="session_title", message=title))

    async def _maybe_update_session_title(self) -> None:
        assert self._bundle is not None
        metadata = self._bundle.engine.tool_metadata
        if bool(metadata.get("session_title_user_edited")):
            return
        current_title = str(metadata.get("session_title") or "").strip()
        title_source = str(metadata.get("session_title_source") or "").strip()
        if current_title and title_source != _SESSION_TITLE_SOURCE_PROMPT:
            return
        messages = self._bundle.engine.messages
        user_messages = [message for message in messages if message.role == "user" and message.text.strip()]
        assistant_messages = [message for message in messages if message.role == "assistant" and message.text.strip()]
        if not user_messages or not assistant_messages:
            return
        try:
            title = await asyncio.wait_for(self._generate_session_title(messages), timeout=8)
        except Exception as exc:
            log.debug("Could not generate session title: %s", exc)
            return
        first_user_text = user_messages[0].text.strip()
        if title and (not title_matches_first_user(title, first_user_text) or title_echoes_first_user(title, first_user_text)):
            title = fallback_session_title_from_user_text(first_user_text)
        if not title:
            return
        metadata["session_title"] = title
        metadata["session_title_source"] = _SESSION_TITLE_SOURCE_CONVERSATION
        if os.environ.get("MYHARNESS_WEB_CLIENT_ID"):
            metadata["web_client_id"] = os.environ["MYHARNESS_WEB_CLIENT_ID"]
        if title != current_title:
            await self._emit(BackendEvent(type="session_title", message=title))
        self._bundle.session_backend.save_snapshot(
            cwd=self._bundle.cwd,
            model=self._bundle.engine.model,
            system_prompt=self._bundle.engine.system_prompt,
            messages=self._bundle.engine.messages,
            usage=self._bundle.engine.total_usage,
            session_id=self._bundle.session_id,
            tool_metadata=metadata,
            history_events=self._history_events,
            usage_accounting=self._bundle.engine.usage_accounting,
        )

    async def _generate_session_title(self, messages: list[ConversationMessage]) -> str:
        assert self._bundle is not None
        snippets: list[str] = []
        for message in messages:
            if message.role not in {"user", "assistant"}:
                continue
            text = " ".join(message.text.strip().split())
            if not text:
                continue
            snippets.append(f"{message.role}: {text[:700]}")
            if len(snippets) >= 6:
                break
        if not snippets:
            return ""
        prompt = (
            "Create a short chat history title for the conversation below.\n"
            "Rules:\n"
            "- Reply with only the title text.\n"
            "- Korean is preferred if the conversation is Korean.\n"
            "- Keep it under 24 Korean characters or 7 English words.\n"
            "- Use the early conversation context, not just the latest message.\n"
            "- Anchor the title on the first substantial user request.\n"
            "- If later messages switch to an unrelated topic, keep the title about the initial topic.\n"
            "- Later messages may only refine the title when they clarify the initial request.\n"
            "- Preserve exact product, game, company, file, and project names from the first user message.\n"
            "- If the first user message names a subject, the title must include that subject.\n"
            "- Do not copy the user's full request; summarize the subject and outcome only.\n"
            "- Prefer noun phrases like '삼성전자 메모리 경쟁사 보고서' over command phrases.\n"
            "- Do not use quotes, punctuation-heavy phrasing, or generic words like '대화'.\n\n"
            + "\n".join(snippets)
        )
        request = ApiMessageRequest(
            model=self._bundle.engine.model,
            messages=[ConversationMessage.from_user_text(prompt)],
            system_prompt="You write concise, specific chat history titles.",
            max_tokens=32,
            tools=[],
        )
        title = ""
        async for event in self._bundle.api_client.stream_message(request):
            if isinstance(event, ApiMessageCompleteEvent):
                title = event.message.text.strip()
                break
        return self._clean_session_title(title)

    def _clean_session_title(self, title: str) -> str:
        cleaned = " ".join(str(title or "").strip().split())
        cleaned = cleaned.strip("\"'`“”‘’ ")
        cleaned = cleaned.replace("\n", " ").replace("\r", " ")
        if not cleaned:
            return ""
        for prefix in ("제목:", "Title:", "title:"):
            if cleaned.startswith(prefix):
                cleaned = cleaned[len(prefix):].strip()
        return cleaned[:80]

    def _set_saved_session_id(self, session_id: str) -> None:
        assert self._bundle is not None
        clean_id = session_id.strip()
        if not clean_id:
            return
        self._bundle.session_id = clean_id
        self._bundle.engine.tool_metadata["session_id"] = clean_id

    def _reset_session_scoped_metadata(self) -> None:
        assert self._bundle is not None
        for key in (
            "session_title",
            "session_title_source",
            "session_title_user_edited",
            "workflow_duration_seconds",
        ):
            self._bundle.engine.tool_metadata.pop(key, None)

    def _start_new_saved_session(self, session_id: str | None = None) -> str:
        requested_id = str(session_id or "").strip().lower()
        session_id = requested_id if _SAVED_SESSION_ID_RE.fullmatch(requested_id) else uuid4().hex[:12]
        self._reset_session_scoped_metadata()
        self._set_saved_session_id(session_id)
        self._history_events = []
        return session_id

    async def _handle_start_new_session(self, session_id: str) -> None:
        assert self._bundle is not None
        self._bundle.engine.clear()
        new_session_id = self._start_new_saved_session(session_id)
        self._save_empty_session_snapshot("새 대화")
        await self._emit(BackendEvent(type="clear_transcript"))
        await self._emit(BackendEvent(type="active_session", value=new_session_id))
        await self._emit(BackendEvent(type="session_title", message="새 대화"))

    def _restore_session_tool_metadata(self, snapshot: dict[str, object]) -> None:
        assert self._bundle is not None
        metadata = self._bundle.engine.tool_metadata
        for key, default_value in _RESTORABLE_TOOL_METADATA_DEFAULTS.items():
            if default_value is None:
                metadata.pop(key, None)
            else:
                metadata[key] = copy.deepcopy(default_value)
        snapshot_metadata = snapshot.get("tool_metadata")
        if isinstance(snapshot_metadata, dict):
            metadata.update(snapshot_metadata)

    def _save_empty_session_snapshot(self, title: str) -> None:
        assert self._bundle is not None
        metadata = dict(self._bundle.engine.tool_metadata)
        metadata["session_title"] = title
        if os.environ.get("MYHARNESS_WEB_CLIENT_ID"):
            metadata["web_client_id"] = os.environ["MYHARNESS_WEB_CLIENT_ID"]
        self._bundle.session_backend.save_snapshot(
            cwd=self._bundle.cwd,
            model=self._bundle.engine.model,
            system_prompt=self._bundle.engine.system_prompt,
            messages=self._bundle.engine.messages,
            usage=self._bundle.engine.total_usage,
            session_id=self._bundle.session_id,
            tool_metadata=metadata,
            history_events=[],
            usage_accounting=self._bundle.engine.usage_accounting,
        )

    def _save_current_session_snapshot(self) -> None:
        assert self._bundle is not None
        metadata = dict(self._bundle.engine.tool_metadata)
        if os.environ.get("MYHARNESS_WEB_CLIENT_ID"):
            metadata["web_client_id"] = os.environ["MYHARNESS_WEB_CLIENT_ID"]
        self._bundle.session_backend.save_snapshot(
            cwd=self._bundle.cwd,
            model=self._bundle.engine.model,
            system_prompt=self._bundle.engine.system_prompt,
            messages=self._bundle.engine.messages,
            usage=self._bundle.engine.total_usage,
            session_id=self._bundle.session_id,
            tool_metadata=metadata,
            history_events=self._history_events,
            usage_accounting=self._bundle.engine.usage_accounting,
        )

    def _skill_snapshots(self) -> list[SkillSnapshot]:
        assert self._bundle is not None
        settings = self._bundle.current_settings()
        registry = load_skill_registry(
            self._bundle.cwd,
            extra_skill_dirs=self._bundle.extra_skill_dirs,
            extra_plugin_roots=self._bundle.extra_plugin_roots,
            settings=settings,
            include_disabled=True,
        )
        hide_learned = settings.learning.effective_mode == "hide"
        return [
            SkillSnapshot(
                name=skill.name,
                description=display_skill_description(skill),
                source=skill.source,
                enabled=skill.enabled,
            )
            for skill in registry.list_skills()
            if skill.source not in _BUILT_IN_SKILL_SOURCES
            if not hide_learned or not is_learned_skill(skill)
        ]

    def _sync_learning_mode(self) -> None:
        assert self._bundle is not None
        settings = self._bundle.current_settings()
        self._bundle.engine.set_auto_skill_learning_enabled(settings.learning.effective_mode != "off")

    async def _handle_set_skill_enabled(self, name: str, enabled: bool | None) -> None:
        if not name.strip():
            await self._emit(BackendEvent(type="error", message="Skill name is required"))
            return
        assert self._bundle is not None
        set_project_skill_enabled(
            self._bundle.cwd,
            name,
            enabled is not False,
            self._bundle.current_settings(),
        )
        await self._emit(BackendEvent.skills_snapshot(self._skill_snapshots()))
        await self._emit(self._status_snapshot())

    async def _handle_set_mcp_enabled(self, name: str, enabled: bool | None) -> None:
        assert self._bundle is not None
        if not name.strip():
            await self._emit(BackendEvent(type="error", message="MCP 서버 이름이 필요합니다."))
            return
        settings = self._bundle.current_settings()
        configs = load_mcp_server_configs(
            settings,
            self._bundle.current_plugins(),
            cwd=self._bundle.cwd,
            include_disabled=True,
        )
        if name not in configs:
            await self._emit(BackendEvent(type="error", message=f"알 수 없는 MCP 서버입니다: {name}"))
            return
        set_project_mcp_enabled(self._bundle.cwd, name, enabled is not False, settings)
        await self._refresh_mcp_configs()
        await self._emit(self._status_snapshot())

    async def _refresh_mcp_configs(self) -> None:
        """Connect newly discovered MCP configs and expose their tools immediately."""
        assert self._bundle is not None
        configs = load_mcp_server_configs(
            self._bundle.current_settings(),
            self._bundle.current_plugins(),
            cwd=self._bundle.cwd,
        )
        changed = False
        for name, config in configs.items():
            changed = await self._bundle.mcp_manager.ensure_server_config(name, config) or changed
        if not changed:
            return
        for tool_info in self._bundle.mcp_manager.list_tools():
            self._bundle.tool_registry.register(McpToolAdapter(self._bundle.mcp_manager, tool_info))
        sync_app_state(self._bundle)

    async def _ensure_forced_mcp_available(self, server_name: str) -> bool:
        """Connect an explicitly selected MCP server without enabling it globally."""
        assert self._bundle is not None
        configs = load_mcp_server_configs(
            self._bundle.current_settings(),
            self._bundle.current_plugins(),
            cwd=self._bundle.cwd,
            include_disabled=True,
        )
        config = configs.get(server_name)
        if config is None:
            return False
        ensure = getattr(self._bundle.mcp_manager, "ensure_server_config", None)
        if ensure is None:
            return False
        if "force_connect" in inspect.signature(ensure).parameters:
            await ensure(server_name, config, force_connect=True)
        else:
            await ensure(server_name, config)
        return True

    def _tool_registry_for_selected_mcp(self, server_name: str) -> ToolRegistry | None:
        assert self._bundle is not None
        registry = ToolRegistry()
        matched = False
        source_registry = getattr(self._bundle, "tool_registry", None)
        if source_registry is not None:
            for tool in source_registry.list_tools():
                if isinstance(tool, McpToolAdapter):
                    if getattr(tool, "_tool_info").server_name != server_name:
                        continue
                    matched = True
                registry.register(tool)
        for tool_info in self._bundle.mcp_manager.list_tools():
            if tool_info.server_name != server_name:
                continue
            registry.register(McpToolAdapter(self._bundle.mcp_manager, tool_info))
            matched = True
        return registry if matched else None

    async def _handle_set_plugin_enabled(self, name: str, enabled: bool | None) -> None:
        assert self._bundle is not None
        if not name.strip():
            await self._emit(BackendEvent(type="error", message="플러그인 이름이 필요합니다."))
            return
        settings = self._bundle.current_settings()
        plugins = {plugin.manifest.name: plugin for plugin in self._bundle.current_plugins()}
        if name not in plugins:
            await self._emit(BackendEvent(type="error", message=f"알 수 없는 플러그인입니다: {name}"))
            return
        set_project_plugin_enabled(
            self._bundle.cwd,
            name,
            enabled is not False,
            settings,
            reset_skill_names=[skill.name for skill in plugins[name].skills],
        )
        await self._emit(BackendEvent.skills_snapshot(self._skill_snapshots()))
        await self._emit(self._status_snapshot())

    def _line_with_forced_skill(self, line: str) -> str:
        mcp_prompt = self._line_with_forced_mcp(line)
        if mcp_prompt is not None:
            return mcp_prompt
        parsed = self._parse_forced_skill_line(line)
        if parsed is None:
            return line
        skill_name, user_request = parsed
        skill = self._loaded_skill_by_name(skill_name)
        if skill is None:
            return line
        request_text = user_request.strip() or "(No additional request was provided.)"
        skill_description = display_skill_description(skill).strip() or skill.description.strip()
        return (
            f"The user explicitly selected the `{skill.name}` skill with `$`. "
            "Treat the selected skill content below as mandatory task guidance and follow it "
            "before applying any general approach.\n\n"
            f"Selected skill: {skill.name}\n"
            f"Description: {skill_description}\n\n"
            "# Selected Skill Content\n"
            "```md\n"
            f"{skill.content.strip()}\n"
            "```\n\n"
            f"User request:\n{request_text}"
        )

    def _line_with_forced_mcp(self, line: str) -> str | None:
        parsed = self._parse_forced_mcp_line(line)
        if parsed is None:
            return None
        server_name, user_request = parsed
        manager_status = None
        if self._bundle is not None:
            manager_status = next(
                (
                    item
                    for item in self._bundle.mcp_manager.list_statuses()
                    if item.name.lower() == server_name.lower()
                ),
                None,
            )
        status = manager_status or next(
            (item for item in self._mcp_statuses_for_snapshot() if item.name.lower() == server_name.lower()),
            None,
        )
        if status is None or (status.state == "disabled" and manager_status is None):
            return None
        request_text = user_request.strip() or "(No additional request was provided.)"
        tool_names = [
            f"mcp__{_sanitize_tool_segment(status.name)}__{_sanitize_tool_segment(tool.name)}"
            for tool in status.tools
        ]
        tool_line = ", ".join(tool_names) if tool_names else "(tool list not available yet)"
        list_tables_tool = next((name for name in tool_names if name.endswith("__list_tables")), "")
        return (
            f"The user explicitly selected the `{status.name}` MCP server with `$mcp:`. "
            "Use this selected MCP server before answering whenever the request can be satisfied by it. "
            "If the server exposes an appropriate tool, call that MCP tool first and base the answer on the result. "
            "Keep MCP usage tight: make at most two targeted searches before summarizing, and if one search returns useful results, stop broad keyword retries. "
            "If an MCP result says [NOT_FOUND], do not repeat similar keyword variations more than once; report the miss briefly and summarize any successful results. "
            "For questions about what data is available or what can be queried, call "
            f"`{list_tables_tool or 'the selected MCP list_tables tool'}` first instead of relying only on generic MCP resource listing.\n\n"
            f"Selected MCP server: {status.name}\n"
            f"State: {status.state}\n"
            f"Transport: {status.transport}\n"
            f"Available selected MCP tools: {tool_line}\n\n"
            f"User request:\n{request_text}"
        )

    def _loaded_skill_by_name(self, name: str) -> SkillDefinition | None:
        assert self._bundle is not None
        registry = load_skill_registry(
            self._bundle.cwd,
            extra_skill_dirs=self._bundle.extra_skill_dirs,
            extra_plugin_roots=self._bundle.extra_plugin_roots,
            settings=self._bundle.current_settings(),
        )
        for skill in registry.list_skills():
            if skill.name.lower() == name.lower():
                return skill
        return None

    def _parse_forced_skill_line(self, line: str) -> tuple[str, str] | None:
        stripped = line.strip()
        if not stripped.startswith("$") or stripped == "$":
            return None
        remainder = stripped[1:].lstrip()
        if not remainder:
            return None
        if remainder[0] in {"'", '"'}:
            quote = remainder[0]
            end = remainder.find(quote, 1)
            if end <= 1:
                return None
            requested_name = remainder[1:end].strip()
            user_request = remainder[end + 1 :].lstrip()
        else:
            requested_name, _, user_request = remainder.partition(" ")
            requested_name = requested_name.strip()
        if not requested_name:
            return None
        skills = {skill.name.lower(): skill for skill in self._skill_snapshots()}
        requested_key = requested_name.lower()
        canonical_skill = skills.get(requested_key)
        if canonical_skill is None and requested_key.startswith("mcp:"):
            mcp_skill = skills.get(requested_key.removeprefix("mcp:"))
            if mcp_skill is not None and is_mcp_routed_skill_source(mcp_skill.source):
                canonical_skill = mcp_skill
        canonical_name = canonical_skill.name if canonical_skill is not None else None
        if canonical_name is None:
            return None
        return canonical_name, user_request

    def _parse_forced_mcp_line(self, line: str) -> tuple[str, str] | None:
        statuses = self._mcp_statuses_for_snapshot()
        servers = {
            alias: status.name
            for status in statuses
            for alias in self._mcp_name_aliases(status.name)
        }
        skills = {skill.name.lower() for skill in self._skill_snapshots()}
        for match in re.finditer(r"(?<!\S)\$(?:mcp:)?([A-Za-z0-9_.:-]+)(?!\S)", line):
            requested_name = match.group(1).strip()
            if not requested_name:
                continue
            canonical_name = servers.get(self._mcp_name_key(requested_name))
            if canonical_name is None:
                continue
            if not match.group(0).lower().startswith("$mcp:") and requested_name.lower() in skills:
                continue
            user_request = f"{line[:match.start()]}{line[match.end():]}".strip()
            return canonical_name, user_request
        line_key = self._mcp_name_key(line)
        for status in statuses:
            aliases = self._mcp_name_aliases(status.name)
            matched_alias = next((alias for alias in aliases if alias and alias in line_key), "")
            if not matched_alias:
                continue
            display_alias = self._mcp_display_name(status.name)
            user_request = re.sub(
                re.escape(display_alias),
                "",
                line,
                count=1,
                flags=re.IGNORECASE,
            ).strip()
            if user_request == line.strip():
                user_request = re.sub(re.escape(status.name), "", line, count=1, flags=re.IGNORECASE).strip()
            return status.name, user_request
        return None

    def _parse_forced_mcp_routed_skill_line(self, line: str) -> tuple[str, str] | None:
        parsed = self._parse_forced_skill_line(line)
        if parsed is None:
            return None
        skill_name, user_request = parsed
        skill = self._loaded_skill_by_name(skill_name)
        if skill is None:
            return None
        server_name = self._mcp_server_name_from_skill_source(skill.source)
        if not server_name:
            return None
        return server_name, user_request

    def _mcp_server_name_from_skill_source(self, source: str) -> str:
        return mcp_server_name_from_skill_source(source)

    def _mcp_name_aliases(self, name: str) -> set[str]:
        return {
            self._mcp_name_key(name),
            self._mcp_name_key(self._mcp_display_name(name)),
            self._mcp_name_key(name.replace("_", " ")),
            self._mcp_name_key(name.replace("-", " ")),
        }

    def _mcp_display_name(self, name: str) -> str:
        return " ".join(part.capitalize() for part in re.split(r"[_-]+", name) if part)

    def _mcp_name_key(self, value: str) -> str:
        return re.sub(r"[^a-z0-9]+", "", value.lower())

    async def _apply_select_command(self, command_name: str, value: str) -> bool:
        command = command_name.strip().lstrip("/").lower()
        selected = value.strip()
        if command == "resume":
            await self._restore_history_snapshot(selected)
            return True
        if command in {"provider", "model", "subagent_model", "effort", "subagent_effort"}:
            await self._apply_runtime_choice(command, selected)
            return True
        line = self._build_select_command_line(command, selected)
        if line is None:
            await self._emit(BackendEvent(type="error", message=f"알 수 없는 선택 명령입니다: {command_name}"))
            await self._emit(BackendEvent(type="line_complete"))
            return True
        quiet = command in {"model", "subagent_model", "effort", "subagent_effort"}
        return await self._process_line(line, transcript_line=f"/{command}", quiet=quiet)

    def _build_select_command_line(self, command: str, value: str) -> str | None:
        if command == "provider":
            return f"/provider {value}"
        if command == "resume":
            return f"/resume {value}" if value else "/resume"
        if command == "permissions":
            return f"/permissions {value}"
        if command == "theme":
            return f"/theme {value}"
        if command == "output-style":
            return f"/output-style {value}"
        if command == "effort":
            return f"/effort {value}"
        if command == "passes":
            return f"/passes {value}"
        if command == "turns":
            return f"/turns {value}"
        if command == "fast":
            return f"/fast {value}"
        if command == "vim":
            return f"/vim {value}"
        if command == "voice":
            return f"/voice {value}"
        if command == "model":
            return f"/model {value}"
        return None

    async def _apply_runtime_choice(self, command: str, selected: str) -> None:
        assert self._bundle is not None
        if not selected:
            await self._emit(BackendEvent(type="error", message=f"Missing {command} value"))
            await self._emit(BackendEvent(type="line_complete"))
            return

        settings = self._bundle.current_settings()
        active_profile_name, active_profile = settings.resolve_profile()
        message = ""
        refresh_client = False

        if command == "provider":
            profiles = AuthManager(settings).list_profiles()
            if selected not in profiles:
                await self._emit(BackendEvent(type="error", message=f"알 수 없는 제공자 프로필입니다: {selected}"))
                await self._emit(BackendEvent(type="line_complete"))
                return
            self._bundle.settings_overrides["active_profile"] = selected
            self._bundle.settings_overrides.pop("model", None)
            profile = profiles[selected]
            message = f"제공자 프로필을 {selected}({profile.label})(으)로 전환했습니다."
            refresh_client = True
        elif command in {"model", "subagent_model"}:
            if active_profile.allowed_models and selected.lower() != "default" and selected not in active_profile.allowed_models:
                allowed = ", ".join(active_profile.allowed_models)
                await self._emit(
                    BackendEvent(
                        type="error",
                        message=f"Model '{selected}' is not allowed for profile '{active_profile_name}'. Allowed models: {allowed}",
                    )
                )
                await self._emit(BackendEvent(type="line_complete"))
                return
            target_key = "model" if command == "model" else "subagent_model"
            target_label = "모델" if command == "model" else "서브에이전트 모델"
            if selected.lower() == "default":
                self._bundle.settings_overrides.pop(target_key, None)
                message = f"{target_label}을(를) 기본값으로 되돌렸습니다."
            else:
                self._bundle.settings_overrides[target_key] = selected
                message = f"{target_label}을(를) {selected}(으)로 설정했습니다."
            refresh_client = command == "model"
        else:
            if selected not in {"auto", "none", "low", "medium", "high", "xhigh", "max"}:
                await self._emit(BackendEvent(type="error", message="사용법: /effort [show|auto|low|medium|high|xhigh|max]"))
                await self._emit(BackendEvent(type="line_complete"))
                return
            stored_value = "none" if selected == "auto" else selected
            target_key = "effort" if command == "effort" else "subagent_effort"
            target_label = "추론 강도" if command == "effort" else "서브에이전트 추론 강도"
            self._bundle.settings_overrides[target_key] = stored_value
            message = f"{target_label}를 {stored_value}(으)로 설정했습니다."

        if refresh_client:
            refresh_runtime_client(self._bundle)
        updated = self._bundle.current_settings()
        self._bundle.engine.tool_metadata["active_profile"] = updated.active_profile
        self._bundle.engine.tool_metadata["provider"] = updated.provider
        self._bundle.engine.tool_metadata["runtime_model"] = updated.model
        self._bundle.engine.tool_metadata["subagent_model"] = updated.subagent_model
        self._bundle.engine.tool_metadata["subagent_effort"] = updated.subagent_effort
        if command == "effort":
            self._bundle.engine.set_reasoning_effort(updated.effort)
        self._bundle.engine.set_system_prompt(
            build_runtime_system_prompt(
                updated,
                cwd=self._bundle.cwd,
                latest_user_prompt=None,
                extra_skill_dirs=self._bundle.extra_skill_dirs,
                extra_plugin_roots=self._bundle.extra_plugin_roots,
            )
        )
        if not refresh_client:
            self._bundle.app_state.set(
                effort=updated.effort,
                subagent_model=updated.subagent_model,
                subagent_effort=updated.subagent_effort,
            )
        await self._emit(self._status_snapshot())
        await self._emit(BackendEvent(type="line_complete", quiet=True))

    async def _restore_history_snapshot(self, session_id: str) -> None:
        assert self._bundle is not None
        selected = session_id.strip()
        if not selected:
            await self._emit(BackendEvent(type="error", message="세션 ID가 없습니다."))
            await self._emit(BackendEvent(type="line_complete"))
            return
        snapshot = self._bundle.session_backend.load_by_id(self._bundle.cwd, selected)
        if snapshot is None:
            await self._emit(BackendEvent(type="error", message=f"세션을 찾을 수 없습니다: {selected}"))
            await self._emit(BackendEvent(type="line_complete"))
            return
        messages = sanitize_conversation_messages(
            [ConversationMessage.model_validate(item) for item in snapshot.get("messages", [])]
        )
        history_events = snapshot.get("history_events")
        if not isinstance(history_events, list) or not history_events:
            history_events = self._history_events_from_messages(messages)
        self._history_events = [
            dict(item)
            for item in history_events
            if isinstance(item, dict) and str(item.get("type") or "").strip()
        ]
        self._bundle.engine.load_messages(messages)
        self._bundle.engine.load_usage(
            usage=snapshot.get("usage") if isinstance(snapshot.get("usage"), dict) else None,
            accounting=snapshot.get("usage_accounting") if isinstance(snapshot.get("usage_accounting"), dict) else None,
            provider=str((snapshot.get("tool_metadata") if isinstance(snapshot.get("tool_metadata"), dict) else {}).get("provider") or ""),
            model=str(snapshot.get("model") or self._bundle.engine.model),
        )
        self._restore_session_tool_metadata(snapshot)
        self._set_saved_session_id(selected)
        await self._emit(BackendEvent(type="clear_transcript"))
        await self._emit(
            BackendEvent(
                type="history_snapshot",
                value=selected,
                message=str(snapshot.get("summary") or "").strip(),
                compact_metadata={
                    "workflow_duration_seconds": (
                        snapshot.get("tool_metadata", {}) if isinstance(snapshot.get("tool_metadata"), dict) else {}
                    ).get("workflow_duration_seconds")
                },
                history_events=self._history_events,
            )
        )
        await self._emit(self._status_snapshot())
        await self._emit(BackendEvent.tasks_snapshot(get_task_manager().list_tasks()))
        self._ensure_async_agent_monitor()
        await self._emit(BackendEvent(type="line_complete"))

    def _history_events_from_messages(self, messages: list[ConversationMessage]) -> list[dict[str, object]]:
        events: list[dict[str, object]] = []
        pending_tools: dict[str, tuple[str, dict[str, object]]] = {}
        for message in messages:
            if message.role == "user":
                user_text = message.text.strip()
                has_image = any(isinstance(block, ImageBlock) for block in message.content)
                if has_image and "[image]" not in user_text:
                    user_text = f"{user_text} [image]".strip()
                if user_text:
                    events.append({"type": "user", "text": user_text})
                for block in message.content:
                    if not isinstance(block, ToolResultBlock):
                        continue
                    tool_name, tool_input = pending_tools.pop(block.tool_use_id, ("tool", {}))
                    events.append(
                        {
                            "type": "tool_completed",
                            "tool_name": tool_name,
                            "tool_input": tool_input,
                            "output": block.content,
                            "is_error": block.is_error,
                        }
                    )
            elif message.role == "assistant":
                for tool_use in message.tool_uses:
                    tool_input = dict(tool_use.input)
                    pending_tools[tool_use.id] = (tool_use.name, tool_input)
                    events.append(
                        {
                            "type": "tool_started",
                            "tool_name": tool_use.name,
                            "tool_input": tool_input,
                        }
                    )
                if message.text.strip():
                    events.append({"type": "assistant", "text": message.text.strip()})
        return events

    def _status_snapshot(self) -> BackendEvent:
        assert self._bundle is not None
        event = BackendEvent.status_snapshot(
            state=self._bundle.app_state.get(),
            mcp_servers=self._mcp_statuses_for_snapshot(),
            plugins=self._plugin_snapshots(),
            bridge_sessions=get_bridge_manager().list_sessions(),
        )
        event.session_usage = self._bundle.engine.usage_cost_summary()
        return event

    def _mcp_statuses_for_snapshot(self) -> list[McpConnectionStatus]:
        assert self._bundle is not None
        statuses = {status.name: status for status in self._bundle.mcp_manager.list_statuses()}
        configs = load_mcp_server_configs(
            self._bundle.current_settings(),
            self._bundle.current_plugins(),
            cwd=self._bundle.cwd,
            include_disabled=True,
        )
        disabled = set(self._bundle.current_settings().disabled_mcp_servers or set())
        for name, config in configs.items():
            transport = getattr(config, "type", "unknown")
            if name in disabled:
                statuses[name] = McpConnectionStatus(
                    name=name,
                    state="disabled",
                    detail="Disabled in settings.",
                    transport=str(transport),
                )
                continue
            if name in statuses:
                continue
            statuses[name] = McpConnectionStatus(
                name=name,
                state="pending",
                detail="Configured; restart or reload backend to connect.",
                transport=str(transport),
            )
        return sorted(statuses.values(), key=lambda status: status.name)

    def _plugin_snapshots(self) -> list[PluginSnapshot]:
        assert self._bundle is not None
        preferences = load_project_preferences(self._bundle.cwd)
        disabled_skill_names = set(preferences.disabled_skills) if preferences is not None else set()
        return [
            PluginSnapshot(
                name=plugin.manifest.name,
                description=plugin.manifest.description,
                enabled=plugin.enabled,
                skill_count=len(plugin.skills),
                skills=[
                    SkillSnapshot(
                        name=skill.name,
                        description=display_skill_description(skill),
                        source=skill.source,
                        enabled=skill.enabled,
                    )
                    for skill in apply_skill_enabled_state(plugin.skills, disabled_skill_names)
                ],
                command_count=len(plugin.commands),
                mcp_server_count=len(plugin.mcp_servers),
            )
            for plugin in self._bundle.current_plugins()
        ]

    async def _emit_todo_update(self, tool_input: dict, output: str) -> None:
        """Emit a todo_update event from TodoWrite input, persisted content, or output."""
        todos = tool_input.get("todos") or tool_input.get("content") or []
        if isinstance(todos, list) and todos:
            lines = []
            for item in todos:
                if isinstance(item, dict):
                    checked = item.get("checked") or item.get("status") in ("done", "completed", "x", True)
                    text = item.get("text") or item.get("content") or str(item)
                    lines.append(f"- [{'x' if checked else ' '}] {text}")
            if lines:
                await self._emit(BackendEvent(type="todo_update", todo_markdown="\n".join(lines)))
                return

        assert self._bundle is not None
        path_value = str(tool_input.get("path") or "TODO.md")
        path = Path(self._bundle.cwd) / path_value
        if path.exists():
            markdown = self._extract_todo_markdown(path.read_text(encoding="utf-8"))
            if markdown:
                await self._emit(BackendEvent(type="todo_update", todo_markdown=markdown))
                return

        markdown = self._extract_todo_markdown(output)
        if markdown:
            await self._emit(BackendEvent(type="todo_update", todo_markdown=markdown))

    @staticmethod
    def _extract_todo_markdown(text: str) -> str:
        lines = text.splitlines()
        checklist_lines = [line for line in lines if line.strip().startswith("- [")]
        return "\n".join(checklist_lines)

    def _emit_swarm_status(self, teammates: list[dict], notifications: list[dict] | None = None) -> None:
        """Emit a swarm_status event synchronously (schedule as coroutine)."""
        import asyncio
        loop = asyncio.get_event_loop()
        loop.create_task(
            self._emit(BackendEvent(type="swarm_status", swarm_teammates=teammates, swarm_notifications=notifications))
        )

    def _swarm_teammate_snapshots(self) -> list[dict]:
        manager = get_task_manager()
        snapshots: list[dict] = []
        try:
            tasks = manager.list_tasks()
        except Exception:
            return snapshots

        for task in tasks:
            if task.type not in _SWARM_TASK_TYPES:
                continue
            metadata = getattr(task, "metadata", {}) if isinstance(getattr(task, "metadata", {}), dict) else {}
            description = str(metadata.get("agent_description") or task.description or f"작업자 {task.id}").strip()
            agent_id = str(metadata.get("agent_id") or "").strip()
            if not agent_id:
                agent_id = (task.description or "").removeprefix("Teammate:").strip() or task.id
            name = agent_id.split("@", 1)[0] if "@" in agent_id else agent_id
            role = str(metadata.get("agent_role") or name).strip() or name
            try:
                output = manager.read_task_output(task.id, max_bytes=1200)
            except Exception:
                output = ""
            status_note = str(metadata.get("status_note") or "").strip()
            progress = str(metadata.get("progress") or "").strip()
            last_output = status_note or next((line.strip() for line in reversed(output.splitlines()) if line.strip()), "")
            task_status = str(task.status or "").strip().lower()
            show_progress = progress and task_status not in {"completed", "failed", "killed", "done", "error"}
            if show_progress and last_output:
                last_output = f"{progress}% · {last_output}"
            elif show_progress:
                last_output = f"{progress}%"
            started_at = int((task.started_at or task.created_at or time.time()) * 1000)
            ended_at = int(task.ended_at * 1000) if getattr(task, "ended_at", None) else None
            snapshots.append(
                {
                    "id": agent_id,
                    "name": name,
                    "role": role,
                    "status": task.status,
                    "task": description,
                    "model": str(metadata.get("agent_model") or "").strip(),
                    "modelSource": str(metadata.get("agent_model_source") or "").strip(),
                    "prompt": str(metadata.get("agent_prompt") or "").strip(),
                    "startedAt": started_at,
                    "endedAt": ended_at,
                    "lastOutput": last_output,
                    "taskId": task.id,
                }
            )
        return snapshots

    async def _handle_task_output(self, task_id: str, max_bytes: int = 12000) -> None:
        task_id = task_id.strip()
        if not task_id:
            await self._emit(BackendEvent(type="error", message="Missing task id"))
            return
        try:
            output = get_task_manager().read_task_output(task_id, max_bytes=max(1, min(max_bytes, 100000)))
        except ValueError as exc:
            await self._emit(BackendEvent(type="error", message=str(exc)))
            return
        await self._emit(
            BackendEvent(
                type="modal_request",
                modal={
                    "kind": "task_output",
                    "task_id": task_id,
                    "title": f"작업 결과 {task_id}",
                    "output": output or "(출력 없음)",
                },
            )
        )

    async def _handle_task_stop(self, task_id: str) -> None:
        task_id = task_id.strip()
        if not task_id:
            await self._emit(BackendEvent(type="error", message="Missing task id"))
            return
        try:
            manager = get_task_manager()
            task = await manager.stop_task(task_id)
        except ValueError as exc:
            await self._emit(BackendEvent(type="error", message=str(exc)))
            return
        await self._emit(BackendEvent(type="status", message=f"작업자 {task.id}을 중단했습니다."))
        await self._emit(BackendEvent(type="swarm_status", swarm_teammates=self._swarm_teammate_snapshots(), swarm_notifications=[]))
        self._ensure_swarm_status_monitor()

    async def _handle_list_sessions(self) -> None:
        import time as _time

        assert self._bundle is not None
        sessions = self._bundle.session_backend.list_snapshots(self._bundle.cwd, limit=None)
        options = []
        for s in sessions:
            ts = _time.strftime("%m/%d %H:%M", _time.localtime(s["created_at"]))
            summary = s.get("summary", "")[:50] or "새 채팅"
            options.append({
                "value": s["session_id"],
                "label": f"{ts}  {s['message_count']}msg  {summary}",
            })
        await self._emit(
            BackendEvent(
                type="select_request",
                modal={"kind": "select", "title": "세션 이어하기", "command": "resume"},
                select_options=options,
            )
        )

    async def _handle_delete_session(self, session_id: str) -> None:
        assert self._bundle is not None
        session_id = session_id.strip()
        if not session_id:
            await self._emit(BackendEvent(type="error", message="세션 ID가 없습니다."))
            return
        deleted = self._bundle.session_backend.delete_by_id(self._bundle.cwd, session_id)
        if self._bundle.session_id == session_id:
            self._bundle.engine.clear()
            new_session_id = self._start_new_saved_session()
            deleted = True
            await self._emit(BackendEvent(type="clear_transcript"))
            await self._emit(BackendEvent(type="active_session", value=new_session_id))
            await self._emit(BackendEvent(type="session_title", message="MyHarness"))
        if not deleted:
            await self._emit(BackendEvent(type="error", message=f"세션을 찾을 수 없습니다: {session_id}"))
            return
        await self._handle_list_sessions()

    async def _handle_set_system_prompt(self, value: str) -> None:
        assert self._bundle is not None
        system_prompt = value.strip()
        if system_prompt:
            self._bundle.settings_overrides["system_prompt"] = system_prompt
        else:
            self._bundle.settings_overrides.pop("system_prompt", None)
        prompt_text = build_runtime_system_prompt(
            self._bundle.current_settings(),
            cwd=self._bundle.cwd,
            latest_user_prompt=None,
            extra_skill_dirs=self._bundle.extra_skill_dirs,
            extra_plugin_roots=self._bundle.extra_plugin_roots,
        )
        self._bundle.engine.set_system_prompt(prompt_text)
        await self._emit(
            BackendEvent(
                type="transcript_item",
                item=TranscriptItem(role="system", text="시스템 프롬프트 설정을 적용했습니다."),
            )
        )

    async def _handle_refresh_runtime_settings(self) -> None:
        assert self._bundle is not None
        settings = self._bundle.current_settings()
        self._bundle.engine.set_max_tokens(settings.effective_max_tokens())
        await self._emit(self._status_snapshot())

    async def _handle_update_session_title(self, value: str) -> None:
        assert self._bundle is not None
        title = self._clean_session_title(value)
        if not title:
            await self._emit(BackendEvent(type="error", message="Missing session title"))
            return
        metadata = self._bundle.engine.tool_metadata
        metadata["session_title"] = title
        metadata["session_title_source"] = _SESSION_TITLE_SOURCE_CONVERSATION
        metadata["session_title_user_edited"] = True
        if os.environ.get("MYHARNESS_WEB_CLIENT_ID"):
            metadata["web_client_id"] = os.environ["MYHARNESS_WEB_CLIENT_ID"]
        self._bundle.session_backend.save_snapshot(
            cwd=self._bundle.cwd,
            model=self._bundle.engine.model,
            system_prompt=self._bundle.engine.system_prompt,
            messages=self._bundle.engine.messages,
            usage=self._bundle.engine.total_usage,
            session_id=self._bundle.session_id,
            tool_metadata=metadata,
            history_events=self._history_events,
            usage_accounting=self._bundle.engine.usage_accounting,
        )
        await self._emit(BackendEvent(type="session_title", message=title))

    async def _handle_select_command(self, command_name: str) -> None:
        assert self._bundle is not None
        command = command_name.strip().lstrip("/").lower()
        if command == "resume":
            await self._handle_list_sessions()
            return

        settings = self._bundle.current_settings()
        state = self._bundle.app_state.get()
        _, active_profile = settings.resolve_profile()
        current_model = settings.model

        if command == "runtime-picker":
            provider_options = self._provider_select_options(settings)
            profiles = AuthManager(settings).list_profiles()
            model_options_by_provider = {
                str(option["value"]): self._model_select_options(
                    current_model,
                    profiles[str(option["value"])].provider,
                    profiles[str(option["value"])].allowed_models,
                )
                for option in provider_options
                if str(option["value"]) in profiles
            }
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={
                        "kind": "select",
                        "title": "Runtime Picker",
                        "command": "runtime-picker",
                        "runtime_options": {
                            "providers": provider_options,
                            "models_by_provider": model_options_by_provider,
                            "subagent_model": settings.subagent_model,
                            "subagent_effort": settings.subagent_effort,
                            "efforts": self._effort_select_options(settings),
                        },
                    },
                    select_options=[],
                )
            )
            return

        if command == "provider":
            options = self._provider_select_options(settings)
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Provider Profile", "command": "provider"},
                    select_options=options,
                )
            )
            return

        if command == "permissions":
            options = [
                {
                    "value": "default",
                    "label": "Default",
                    "description": "Ask before write/execute operations",
                    "active": settings.permission.mode.value == "default",
                },
                {
                    "value": "full_auto",
                    "label": "Auto",
                    "description": "Allow all tools automatically",
                    "active": settings.permission.mode.value == "full_auto",
                },
                {
                    "value": "plan",
                    "label": "Plan Mode",
                    "description": "Block all write operations",
                    "active": settings.permission.mode.value == "plan",
                },
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Permission Mode", "command": "permissions"},
                    select_options=options,
                )
            )
            return

        if command == "theme":
            options = [
                {
                    "value": name,
                    "label": name,
                    "active": name == settings.theme,
                }
                for name in list_themes()
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Theme", "command": "theme"},
                    select_options=options,
                )
            )
            return

        if command == "output-style":
            options = [
                {
                    "value": style.name,
                    "label": style.name,
                    "description": style.source,
                    "active": style.name == settings.output_style,
                }
                for style in load_output_styles()
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Output Style", "command": "output-style"},
                    select_options=options,
                )
            )
            return

        if command == "effort":
            options = self._effort_select_options(settings)
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Reasoning Effort", "command": "effort"},
                    select_options=options,
                )
            )
            return

        if command == "passes":
            current = int(state.passes or settings.passes)
            options = [
                {"value": str(value), "label": f"{value} pass{'es' if value != 1 else ''}", "active": value == current}
                for value in range(1, 9)
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Reasoning Passes", "command": "passes"},
                    select_options=options,
                )
            )
            return

        if command == "turns":
            current = self._bundle.engine.max_turns
            values = {32, 64, 128, 200, 256, 512}
            if isinstance(current, int):
                values.add(current)
            options = [{"value": "unlimited", "label": "Unlimited", "description": "Do not hard-stop this session", "active": current is None}]
            options.extend(
                {"value": str(value), "label": f"{value} turns", "active": value == current}
                for value in sorted(values)
            )
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Max Turns", "command": "turns"},
                    select_options=options,
                )
            )
            return

        if command == "fast":
            current = bool(state.fast_mode)
            options = [
                {"value": "on", "label": "On", "description": "Prefer shorter, faster responses", "active": current},
                {"value": "off", "label": "Off", "description": "Use normal response mode", "active": not current},
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Fast Mode", "command": "fast"},
                    select_options=options,
                )
            )
            return

        if command == "vim":
            current = bool(state.vim_enabled)
            options = [
                {"value": "on", "label": "On", "description": "Enable Vim keybindings", "active": current},
                {"value": "off", "label": "Off", "description": "Use standard keybindings", "active": not current},
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Vim Mode", "command": "vim"},
                    select_options=options,
                )
            )
            return

        if command == "voice":
            current = bool(state.voice_enabled)
            options = [
                {"value": "on", "label": "On", "description": state.voice_reason or "Enable voice mode", "active": current},
                {"value": "off", "label": "Off", "description": "Disable voice mode", "active": not current},
            ]
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Voice Mode", "command": "voice"},
                    select_options=options,
                )
            )
            return

        if command == "model":
            options = self._model_select_options(current_model, active_profile.provider, active_profile.allowed_models)
            await self._emit(
                BackendEvent(
                    type="select_request",
                    modal={"kind": "select", "title": "Model", "command": "model"},
                    select_options=options,
                )
            )
            return

        await self._emit(BackendEvent(type="error", message=f"No selector available for /{command}"))

    def _provider_select_options(self, settings: Settings) -> list[dict[str, object]]:
        return _provider_select_options(settings)

    def _effort_select_options(self, settings: Settings) -> list[dict[str, object]]:
        return _effort_select_options(settings)

    def _model_select_options(self, current_model: str, provider: str, allowed_models: list[str] | None = None) -> list[dict[str, object]]:
        return _model_select_options(current_model, provider, allowed_models)

    def _model_option_description(self, provider_name: str, model: str) -> str:
        return _model_option_description(provider_name, model)

    async def _ask_permission(self, tool_name: str, reason: str) -> bool:
        async with self._permission_lock:
            request_id = uuid4().hex
            future: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
            self._permission_requests[request_id] = future
            await self._emit(
                BackendEvent(
                    type="modal_request",
                    modal={
                        "kind": "permission",
                        "request_id": request_id,
                        "tool_name": tool_name,
                        "reason": reason,
                    },
                )
            )
            try:
                return await asyncio.wait_for(future, timeout=300)
            except asyncio.TimeoutError:
                log.warning("Permission request %s timed out after 300s, denying", request_id)
                return False
            finally:
                self._permission_requests.pop(request_id, None)

    async def _ask_question(self, question: str, choices: list[dict[str, object]] | None = None) -> str:
        request_id = uuid4().hex
        future: asyncio.Future[str] = asyncio.get_running_loop().create_future()
        self._question_requests[request_id] = future
        normalized_choices = _normalize_question_choices(choices or [])
        self._question_request_details[request_id] = {
            "question": question,
            "choices": normalized_choices,
        }
        await self._emit(
            BackendEvent(
                type="modal_request",
                modal={
                    "kind": "question",
                    "request_id": request_id,
                    "question": question,
                    "choices": normalized_choices,
                },
            )
        )
        try:
            return await future
        finally:
            self._question_requests.pop(request_id, None)
            self._question_request_details.pop(request_id, None)

    def _append_history_event(self, event: dict[str, object]) -> None:
        if not str(event.get("type") or "").strip():
            return
        self._history_events.append(event)
        if len(self._history_events) > 1000:
            self._history_events = self._history_events[-1000:]

    def _record_history_event(self, event: BackendEvent) -> None:
        if event.type == "transcript_item" and event.item is not None:
            item = event.item
            text = item.text.strip()
            if not text:
                return
            if item.role == "user":
                payload: dict[str, object] = {"type": "user", "text": text}
                if item.kind:
                    payload["kind"] = item.kind
                self._append_history_event(payload)
            elif item.role == "assistant":
                self._append_history_event({"type": "assistant", "text": text, "timestamp": int(time.time() * 1000)})
            return

        if event.type == "assistant_complete":
            text = (event.message or "").strip()
            artifacts = event.artifacts if isinstance(event.artifacts, list) else []
            if text or artifacts:
                payload = {
                    "type": "assistant",
                    "text": text,
                    "has_tool_uses": bool(event.has_tool_uses),
                    "timestamp": int(time.time() * 1000),
                }
                if artifacts:
                    payload["artifacts"] = artifacts
                if isinstance(event.usage, dict):
                    payload["usage"] = event.usage
                if isinstance(event.session_usage, dict):
                    payload["session_usage"] = event.session_usage
                self._append_history_event(
                    payload
                )
            return

        if event.type == "line_complete":
            metadata = event.compact_metadata if isinstance(event.compact_metadata, dict) else {}
            try:
                duration_seconds = round(float(metadata.get("workflow_duration_seconds") or 0))
            except (TypeError, ValueError):
                duration_seconds = 0
            if duration_seconds <= 0:
                return
            payload = {"type": "line_complete", "workflow_duration_seconds": duration_seconds}
            if self._history_events and self._history_events[-1].get("type") == "line_complete":
                self._history_events[-1] = payload
            else:
                self._append_history_event(payload)
            return

        if event.type in {"tool_input_delta", "tool_started", "tool_progress", "tool_completed"}:
            payload = {
                "type": event.type,
                "tool_name": event.tool_name or "",
            }
            if event.tool_call_id:
                payload["tool_call_id"] = event.tool_call_id
            if event.tool_call_index is not None:
                payload["tool_call_index"] = event.tool_call_index
            if event.type == "tool_input_delta":
                payload["arguments_delta"] = event.arguments_delta or ""
                previous = self._history_events[-1] if self._history_events else None
                if (
                    previous
                    and previous.get("type") == "tool_input_delta"
                    and previous.get("tool_name") == payload["tool_name"]
                    and previous.get("tool_call_id") == payload.get("tool_call_id")
                    and previous.get("tool_call_index") == payload.get("tool_call_index")
                ):
                    previous["arguments_delta"] = f"{previous.get('arguments_delta') or ''}{payload['arguments_delta']}"
                else:
                    self._append_history_event(payload)
                return
            if event.tool_input:
                payload["tool_input"] = event.tool_input
            if event.type == "tool_progress" and event.message:
                payload["message"] = event.message
            if event.type == "tool_completed":
                payload["output"] = event.output or ""
                payload["is_error"] = bool(event.is_error)
            self._append_history_event(payload)
            return

        if event.type == "swarm_status":
            teammates = event.swarm_teammates if isinstance(event.swarm_teammates, list) else []
            notifications = event.swarm_notifications if isinstance(event.swarm_notifications, list) else []
            if not teammates and not notifications:
                return
            payload = {
                "type": "swarm_status",
                "swarm_teammates": teammates,
                "swarm_notifications": notifications,
            }
            if self._history_events and self._history_events[-1].get("type") == "swarm_status":
                self._history_events[-1] = payload
            else:
                self._append_history_event(payload)

    async def _emit(self, event: BackendEvent) -> None:
        log.debug("emit event: type=%s tool=%s", event.type, getattr(event, "tool_name", None))
        self._record_history_event(event)
        async with self._write_lock:
            payload = _PROTOCOL_PREFIX + event.model_dump_json() + "\n"
            buffer = getattr(sys.stdout, "buffer", None)
            if buffer is not None:
                buffer.write(payload.encode("utf-8"))
                buffer.flush()
                return
            sys.stdout.write(payload)
            sys.stdout.flush()


async def run_backend_host(
    *,
    model: str | None = None,
    subagent_model: str | None = None,
    subagent_effort: str | None = None,
    max_turns: int | None = None,
    base_url: str | None = None,
    system_prompt: str | None = None,
    api_key: str | None = None,
    api_format: str | None = None,
    active_profile: str | None = None,
    effort: str | None = None,
    cwd: str | None = None,
    api_client: SupportsStreamingMessages | None = None,
    restore_messages: list[dict] | None = None,
    restore_tool_metadata: dict[str, object] | None = None,
    restore_usage: dict[str, object] | None = None,
    restore_usage_accounting: dict[str, object] | None = None,
    enforce_max_turns: bool = True,
    permission_mode: str | None = None,
    session_backend: SessionBackend | None = None,
    extra_skill_dirs: tuple[str | Path, ...] = (),
    extra_plugin_roots: tuple[str | Path, ...] = (),
) -> int:
    """Run the structured React backend host."""
    if cwd:
        os.chdir(cwd)
    host = ReactBackendHost(
        BackendHostConfig(
            model=model,
            subagent_model=subagent_model,
            subagent_effort=subagent_effort,
            max_turns=max_turns,
            base_url=base_url,
            system_prompt=system_prompt,
            api_key=api_key,
            api_format=api_format,
            active_profile=active_profile,
            effort=effort,
            api_client=api_client,
            cwd=cwd,
            restore_messages=restore_messages,
            restore_tool_metadata=restore_tool_metadata,
            restore_usage=restore_usage,
            restore_usage_accounting=restore_usage_accounting,
            enforce_max_turns=enforce_max_turns,
            permission_mode=permission_mode,
            session_backend=session_backend,
            extra_skill_dirs=tuple(str(Path(path).expanduser().resolve()) for path in extra_skill_dirs),
            extra_plugin_roots=tuple(str(Path(path).expanduser().resolve()) for path in extra_plugin_roots),
        )
    )
    return await host.run()


__all__ = ["run_backend_host", "ReactBackendHost", "BackendHostConfig"]
