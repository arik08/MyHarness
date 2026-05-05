"""Tool for updating background task metadata."""

from __future__ import annotations

import json
import os
import sys

from pydantic import BaseModel, Field

from myharness.tasks.manager import TASK_PROGRESS_EVENT_PREFIX
from myharness.tasks.manager import get_task_manager
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class TaskUpdateToolInput(BaseModel):
    """Arguments for task updates."""

    task_id: str = Field(description="Task identifier")
    description: str | None = Field(default=None, description="Updated task description")
    progress: int | None = Field(default=None, ge=0, le=100, description="Progress percentage")
    status_note: str | None = Field(default=None, description="Short human-readable task note")


class TaskUpdateTool(BaseTool):
    """Update task metadata for progress tracking."""

    name = "task_update"
    description = "Update a task description, progress, or status note."
    input_model = TaskUpdateToolInput

    def is_read_only(self, arguments: BaseModel) -> bool:
        del arguments
        return True

    async def execute(
        self,
        arguments: TaskUpdateToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        del context
        try:
            task = get_task_manager().update_task(
                arguments.task_id,
                description=arguments.description,
                progress=arguments.progress,
                status_note=arguments.status_note,
            )
        except ValueError as exc:
            parent_task_id = os.environ.get("MYHARNESS_PARENT_TASK_ID", "").strip()
            if parent_task_id and parent_task_id == arguments.task_id:
                _emit_parent_task_update(arguments)
                return ToolResult(output=f"Updated task {parent_task_id}")
            return ToolResult(output=str(exc), is_error=True)

        parts = [f"Updated task {task.id}"]
        if arguments.description:
            parts.append(f"description={task.description}")
        if arguments.progress is not None:
            parts.append(f"progress={task.metadata.get('progress', '')}%")
        if arguments.status_note:
            parts.append(f"note={task.metadata.get('status_note', '')}")
        return ToolResult(output=" ".join(parts))


def _emit_parent_task_update(arguments: TaskUpdateToolInput) -> None:
    payload: dict[str, object] = {"task_id": arguments.task_id}
    if arguments.description is not None:
        payload["description"] = arguments.description
    if arguments.progress is not None:
        payload["progress"] = arguments.progress
    if arguments.status_note is not None:
        payload["status_note"] = arguments.status_note
    print(
        TASK_PROGRESS_EVENT_PREFIX + json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        file=sys.stdout,
        flush=True,
    )
