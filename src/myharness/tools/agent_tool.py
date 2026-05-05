"""Tool for spawning local agent tasks."""

from __future__ import annotations

import logging

from pydantic import BaseModel, Field

from myharness.coordinator.agent_definitions import get_agent_definition
from myharness.coordinator.coordinator_mode import get_team_registry
from myharness.hooks import HookEvent
from myharness.swarm.registry import get_backend_registry
from myharness.swarm.types import TeammateSpawnConfig
from myharness.tasks import get_task_manager
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult

logger = logging.getLogger(__name__)

_GENERIC_AGENT_TYPES = {"agent", "worker", "general-purpose", "default"}
_ROLE_KEYWORDS = ("조사", "정리", "검토", "분석", "수집", "작성", "요약", "검증", "기획")


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


def _prompt_with_task_context(prompt: str) -> str:
    return (
        "You are a background teammate. Your task id is {task_id}. "
        "If you make meaningful progress, call `task_update` with that task id, "
        "a short Korean status_note, and progress when useful. "
        "Keep interim progress brief.\n\n"
        f"{prompt}"
    )


class AgentToolInput(BaseModel):
    """Arguments for local agent spawning."""

    description: str = Field(description="Short description of the delegated work")
    prompt: str = Field(description="Full prompt for the local agent")
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
    description = "Spawn a local background agent task."
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

        # Look up agent definition if subagent_type is specified
        agent_def = None
        if arguments.subagent_type:
            agent_def = get_agent_definition(arguments.subagent_type)

        # Resolve team and agent name for the swarm backend
        team = arguments.team or "default"
        agent_name = arguments.subagent_type or "agent"

        # Use subprocess backend so spawned agents are registered in
        # BackgroundTaskManager and are pollable by the task tools.
        # in_process tasks return asyncio-internal IDs that task tools
        # cannot query, and subprocess is always available on all platforms.
        registry = get_backend_registry()
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
            model=arguments.model or (agent_def.model if agent_def else None),
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
            },
        )
