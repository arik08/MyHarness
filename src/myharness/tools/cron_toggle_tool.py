"""Tool for enabling or disabling local cron jobs."""

from __future__ import annotations

from pydantic import BaseModel, Field

from myharness.services.cron import set_job_enabled
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class CronToggleToolInput(BaseModel):
    """Arguments for toggling a cron job."""

    name: str = Field(description="Cron job name")
    enabled: bool = Field(description="True to enable, False to disable")


class CronToggleTool(BaseTool):
    """Enable or disable a local cron job."""

    name = "cron_toggle"
    description = "Enable or disable a local cron job by name."
    input_model = CronToggleToolInput

    async def execute(
        self,
        arguments: CronToggleToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        del context
        if not set_job_enabled(arguments.name, arguments.enabled):
            return ToolResult(
                output=f"Cron 작업을 찾을 수 없습니다: {arguments.name}",
                is_error=True,
            )
        state = "활성화" if arguments.enabled else "비활성화"
        return ToolResult(output=f"Cron 작업 '{arguments.name}'을(를) {state}했습니다.")
