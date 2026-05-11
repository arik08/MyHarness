"""Tool for spawning local agent tasks."""

from __future__ import annotations

import importlib
import logging
from hashlib import sha1
from typing import Any

from pydantic import BaseModel, Field

from myharness.coordinator.agent_definitions import get_agent_definition
from myharness.coordinator.coordinator_mode import get_team_registry
from myharness.hooks import HookEvent
from myharness.swarm.types import TeammateSpawnConfig
from myharness.tasks import get_task_manager
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult

logger = logging.getLogger(__name__)

_GENERIC_AGENT_TYPES = {"agent", "worker", "general-purpose", "default"}
_ROLE_KEYWORDS = ("조사", "정리", "검토", "분석", "수집", "작성", "요약", "검증", "기획")
_REVIEW_ROLE_KEYWORDS = (
    "검토",
    "검증",
    "분석",
    "리뷰",
    "위험",
    "영향",
    "review",
    "verify",
    "validate",
    "analysis",
    "risk",
)
_CODING_ROLE_KEYWORDS = (
    "구현",
    "수정",
    "코드",
    "테스트",
    "리팩터",
    "버그",
    "implement",
    "code",
    "test",
    "fix",
    "debug",
    "refactor",
)
def _display_role(description: str, subagent_type: str | None) -> str:
    text = " ".join(description.split())
    if text:
        prefix = text.split(":", 1)[0].split("-", 1)[0].strip()
        if 0 < len(prefix) <= 18 and any(keyword in prefix for keyword in _ROLE_KEYWORDS):
            return prefix
        for keyword in _ROLE_KEYWORDS:
            if keyword in text:
                return f"{keyword} 담당"
    agent_type = (subagent_type or "").strip()
    if agent_type and agent_type.lower() not in _GENERIC_AGENT_TYPES:
        return agent_type
    return "작업자"


def _should_use_agent_definition(team: str, subagent_type: str | None) -> bool:
    agent_type = (subagent_type or "").strip()
    if not agent_type:
        return False
    if team == "office" and agent_type.lower() in _GENERIC_AGENT_TYPES:
        return False
    return True


def _agent_name_for_spawn(description: str, team: str, subagent_type: str | None) -> str:
    agent_type = (subagent_type or "").strip()
    if team != "office" or (agent_type and agent_type.lower() not in _GENERIC_AGENT_TYPES):
        return agent_type or "agent"
    role = _display_role(description, subagent_type)
    digest = sha1(description.encode("utf-8")).hexdigest()[:6]
    if "조사" in role:
        prefix = "research"
    elif "정리" in role:
        prefix = "synthesis"
    elif "검토" in role or "검증" in role:
        prefix = "review"
    elif "분석" in role:
        prefix = "analysis"
    else:
        prefix = "office"
    return f"{prefix}-{digest}"


def _prompt_with_task_context(prompt: str) -> str:
    return (
        "You are a background teammate. Your task id is {task_id}. "
        "If you make meaningful progress, call `task_update` with that task id, "
        "a short Korean status_note, and progress when useful. "
        "Keep interim progress brief. If this is source or web research, do not write "
        "the final report yourself. Return concise source cards with each source's key "
        "facts, short content summary, and relevance. Clearly mark the 3-5 sources the "
        "main agent should read directly, with why each source is worth reading and any "
        "uncertainty.\n\n"
        f"{prompt}"
    )


def _runtime_model_from_context(context: ToolExecutionContext) -> str | None:
    value = context.metadata.get("runtime_model") or context.metadata.get("model")
    if isinstance(value, str):
        return value.strip() or None
    return None


def _subagent_model_from_context(context: ToolExecutionContext) -> str | None:
    value = context.metadata.get("subagent_model")
    if isinstance(value, str):
        return value.strip() or None
    return None


def _active_profile_from_context(context: ToolExecutionContext) -> str | None:
    value = context.metadata.get("active_profile")
    if isinstance(value, str):
        return value.strip() or None
    return None


def _subagent_effort_from_context(context: ToolExecutionContext) -> str | None:
    value = context.metadata.get("subagent_effort")
    if isinstance(value, str):
        return value.strip() or None
    return None


def _role_uses_main_model(description: str, prompt: str, subagent_type: str | None) -> bool:
    text = " ".join(
        part.lower()
        for part in (description, prompt[:800], subagent_type or "")
        if part
    )
    if any(keyword in text for keyword in _CODING_ROLE_KEYWORDS):
        return True
    if any(keyword in text for keyword in _REVIEW_ROLE_KEYWORDS):
        return True
    return False


def _resolve_agent_model(
    arguments: "AgentToolInput",
    agent_def: Any,
    context: ToolExecutionContext,
) -> tuple[str | None, str, str]:
    explicit_model = (arguments.model or "").strip()
    if explicit_model:
        return explicit_model, explicit_model, "explicit"
    definition_model = (getattr(agent_def, "model", None) or "").strip() if agent_def else ""
    if definition_model:
        return definition_model, definition_model, "definition"
    runtime_model = _runtime_model_from_context(context)
    if _role_uses_main_model(arguments.description, arguments.prompt, arguments.subagent_type):
        if runtime_model:
            return None, f"inherit ({runtime_model})", "main"
        return None, "inherit", "main"
    subagent_model = _subagent_model_from_context(context)
    if subagent_model:
        return subagent_model, subagent_model, "subagent"
    if runtime_model:
        return None, f"inherit ({runtime_model})", "inherit"
    return None, "inherit", "inherit"


class AgentToolInput(BaseModel):
    """Arguments for local agent spawning."""

    description: str = Field(description="Short role and task description for delegated work")
    prompt: str = Field(
        description=(
            "Short, self-contained worker prompt. Give only the role, goal, needed inputs, "
            "constraints, and output format; do not pass the full conversation unless required."
        )
    )
    subagent_type: str | None = Field(
        default=None,
        description="Agent type for definition lookup (e.g. 'general-purpose', 'Explore', 'worker')",
    )
    model: str | None = Field(default=None)
    command: str | None = Field(default=None, description="Override spawn command")
    team: str | None = Field(default=None, description="Optional team to attach the agent to")
    mode: str = Field(
        default="local_agent",
        description="Agent mode: local_agent, remote_agent, or in_process_teammate",
    )


class AgentTool(BaseTool):
    """Spawn a local agent subprocess."""

    name = "agent"
    description = (
        "Spawn a local background agent task with a narrow role-focused prompt. "
        "For large source or web research, use workers to shortlist evidence and direct-read "
        "recommendations; the main agent should read the strongest sources and synthesize."
    )
    input_model = AgentToolInput

    def requires_project_mutation_lock(self, arguments: BaseModel) -> bool:
        del arguments
        return False

    async def execute(self, arguments: AgentToolInput, context: ToolExecutionContext) -> ToolResult:
        if arguments.mode not in {"local_agent", "remote_agent", "in_process_teammate"}:
            return ToolResult(
                output="Invalid mode. Use local_agent, remote_agent, or in_process_teammate.",
                is_error=True,
            )
        delegated_prompt = arguments.prompt.strip()
        if not delegated_prompt:
            return ToolResult(
                output="Agent prompt is required. Provide a self-contained worker task.",
                is_error=True,
            )

        # Look up agent definition if subagent_type is specified.  Office
        # research often arrives as subagent_type="worker" from generic
        # delegation guidance, but the built-in worker prompt is code-focused.
        agent_def = None
        team = arguments.team or "default"
        if _should_use_agent_definition(team, arguments.subagent_type):
            agent_def = get_agent_definition(arguments.subagent_type)
        agent_model, model_label, model_source = _resolve_agent_model(arguments, agent_def, context)
        agent_effort = _subagent_effort_from_context(context)

        # Resolve team and agent name for the swarm backend
        agent_name = _agent_name_for_spawn(arguments.description, team, arguments.subagent_type)

        # Use subprocess backend so spawned agents are registered in
        # BackgroundTaskManager and are pollable by the task tools.
        # in_process tasks return asyncio-internal IDs that task tools
        # cannot query, and subprocess is always available on all platforms.
        registry_module = importlib.import_module("myharness.swarm.registry")
        registry = registry_module.get_backend_registry()
        executor = registry.get_executor("subprocess")
        worker_prompt = (
            _prompt_with_task_context(delegated_prompt)
            if arguments.command is None
            else delegated_prompt
        )

        config = TeammateSpawnConfig(
            name=agent_name,
            team=team,
            prompt=worker_prompt,
            cwd=str(context.cwd),
            parent_session_id="main",
            model=agent_model,
            active_profile=_active_profile_from_context(context),
            effort=agent_effort,
            command=arguments.command,
            system_prompt=agent_def.system_prompt if agent_def else None,
            permissions=agent_def.permissions if agent_def else [],
            task_type=arguments.mode,
        )

        try:
            result = await executor.spawn(config)
        except Exception as exc:
            logger.error("Failed to spawn agent: %s", exc)
            return ToolResult(output=str(exc), is_error=True)

        if not result.success:
            return ToolResult(output=result.error or "Failed to spawn agent", is_error=True)

        if arguments.team:
            registry = get_team_registry()
            try:
                registry.add_agent(arguments.team, result.task_id)
            except ValueError:
                registry.create_team(arguments.team)
                registry.add_agent(arguments.team, result.task_id)

        manager = get_task_manager()
        task_record = manager.get_task(result.task_id)
        if task_record is not None:
            task_record.metadata["agent_id"] = result.agent_id
            task_record.metadata["agent_role"] = _display_role(arguments.description, arguments.subagent_type)
            task_record.metadata["agent_description"] = arguments.description
            task_record.metadata["agent_model"] = model_label
            task_record.metadata["agent_model_source"] = model_source
            if agent_effort:
                task_record.metadata["agent_effort"] = agent_effort
            task_record.metadata["agent_prompt"] = delegated_prompt
            task_record.metadata["team"] = team
            manager.notify_task_updated(result.task_id)

        if context.hook_executor is not None:
            unregister = None

            async def _emit_subagent_stop(task_record) -> None:
                nonlocal unregister
                if task_record.id != result.task_id:
                    return
                if unregister is not None:
                    unregister()
                    unregister = None
                await context.hook_executor.execute(
                    HookEvent.SUBAGENT_STOP,
                    {
                        "event": HookEvent.SUBAGENT_STOP.value,
                        "agent_id": result.agent_id,
                        "task_id": result.task_id,
                        "backend_type": result.backend_type,
                        "status": task_record.status,
                        "return_code": task_record.return_code,
                        "description": arguments.description,
                        "subagent_type": arguments.subagent_type or "agent",
                        "model": model_label,
                        "model_source": model_source,
                        "team": team,
                        "mode": arguments.mode,
                    },
                )

            unregister = manager.register_completion_listener(_emit_subagent_stop)
            task_record = manager.get_task(result.task_id)
            if task_record is not None and task_record.status in {"completed", "failed", "killed"}:
                await _emit_subagent_stop(task_record)

        return ToolResult(
            output=(
                f"Spawned agent {result.agent_id} "
                f"(task_id={result.task_id}, backend={result.backend_type})"
            ),
            metadata={
                "agent_id": result.agent_id,
                "task_id": result.task_id,
                "backend_type": result.backend_type,
                "description": arguments.description,
                "model": model_label,
                "model_source": model_source,
                "prompt": delegated_prompt,
            },
        )
