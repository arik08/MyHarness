"""Tool for triggering local named jobs on demand."""

from __future__ import annotations

import asyncio
from pathlib import Path

from pydantic import BaseModel, Field

from myharness.services.cron import get_cron_job
from myharness.sandbox import SandboxUnavailableError
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.utils.shell import create_shell_subprocess


class RemoteTriggerToolInput(BaseModel):
    """Arguments for triggering a local named job."""

    name: str = Field(description="Cron job name")
    timeout_seconds: int = Field(default=120, ge=1, le=600)


class RemoteTriggerTool(BaseTool):
    """Run a registered cron job immediately."""

    name = "remote_trigger"
    description = "Trigger a configured local cron-style job immediately."
    input_model = RemoteTriggerToolInput

    async def execute(
        self,
        arguments: RemoteTriggerToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        job = get_cron_job(arguments.name)
        if job is None:
            return ToolResult(output=f"Cron 작업을 찾을 수 없습니다: {arguments.name}", is_error=True)

        cwd = Path(job.get("cwd") or context.cwd).expanduser()
        try:
            process = await create_shell_subprocess(
                str(job["command"]),
                cwd=cwd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except SandboxUnavailableError as exc:
            return ToolResult(output=str(exc), is_error=True)
        try:
            stdout, stderr = await asyncio.wait_for(
                process.communicate(),
                timeout=arguments.timeout_seconds,
            )
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()
            return ToolResult(
                output=f"원격 트리거가 {arguments.timeout_seconds}초 후 시간 초과됐습니다.",
                is_error=True,
            )

        parts = []
        if stdout:
            parts.append(stdout.decode("utf-8", errors="replace").rstrip())
        if stderr:
            parts.append(stderr.decode("utf-8", errors="replace").rstrip())
        body = "\n".join(part for part in parts if part).strip() or "(출력 없음)"
        return ToolResult(
            output=f"{arguments.name} 작업을 실행했습니다.\n{body}",
            is_error=process.returncode != 0,
            metadata={"returncode": process.returncode},
        )
