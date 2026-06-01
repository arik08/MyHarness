"""Tool for creating background tasks."""

from __future__ import annotations

from pydantic import BaseModel, Field

from myharness.subagents import SUBAGENT_INVOCATION_DISABLED_MESSAGE
from myharness.tasks.manager import get_task_manager
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class TaskCreateToolInput(BaseModel):
    """Arguments for task creation."""

    type: str = Field(default="local_bash", description="Task type: local_bash")
    description: str = Field(description="Short task description")
    command: str | None = Field(default=None, description="Shell command for local_bash")
    prompt: str | None = Field(default=None, description="Unused while local_agent tasks are disabled")
    model: str | None = Field(default=None)


class TaskCreateTool(BaseTool):
    """Create a background task."""

    name = "task_create"
    description = "Create a background shell task."
    input_model = TaskCreateToolInput

    def requires_project_mutation_lock(self, arguments: TaskCreateToolInput) -> bool:
        return arguments.type == "local_bash"

    async def execute(self, arguments: TaskCreateToolInput, context: ToolExecutionContext) -> ToolResult:
        manager = get_task_manager()
        try:
            if arguments.type == "local_bash":
                if not arguments.command:
                    return ToolResult(output="command is required for local_bash tasks", is_error=True)
                task = await manager.create_shell_task(
                    command=arguments.command,
                    description=arguments.description,
                    cwd=context.cwd,
                )
            elif arguments.type == "local_agent":
                return ToolResult(output=SUBAGENT_INVOCATION_DISABLED_MESSAGE, is_error=True)
            else:
                return ToolResult(output=f"unsupported task type: {arguments.type}", is_error=True)
        except (OSError, ValueError) as exc:
            return ToolResult(output=str(exc), is_error=True)

        return ToolResult(output=f"Created task {task.id} ({task.type})")
