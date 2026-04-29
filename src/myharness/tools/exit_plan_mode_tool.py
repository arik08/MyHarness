"""Tool for leaving plan permission mode."""

from __future__ import annotations

from pydantic import BaseModel

from myharness.config.settings import load_settings, save_settings
from myharness.permissions import PermissionMode
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class ExitPlanModeToolInput(BaseModel):
    """No-op input model."""


class ExitPlanModeTool(BaseTool):
    """Switch permission mode back to the pre-plan execution mode."""

    name = "exit_plan_mode"
    description = "Switch permission mode back to the pre-plan execution mode."
    input_model = ExitPlanModeToolInput

    async def execute(self, arguments: ExitPlanModeToolInput, context: ToolExecutionContext) -> ToolResult:
        del arguments
        settings = load_settings()
        restored_mode = (
            _normalize_permission_mode(context.metadata.get("plan_previous_permission_mode"))
            or settings.permission.plan_previous_mode
            or (PermissionMode.FULL_AUTO if settings.yolo_mode_enabled else PermissionMode.DEFAULT)
        )
        if restored_mode == PermissionMode.PLAN:
            restored_mode = PermissionMode.FULL_AUTO if settings.yolo_mode_enabled else PermissionMode.DEFAULT
        settings.permission.mode = restored_mode
        settings.permission.plan_previous_mode = None
        save_settings(settings)
        return ToolResult(
            output=f"Permission mode set to {restored_mode.value}",
            metadata={
                "permission_mode": restored_mode.value,
                "plan_previous_permission_mode": "",
            },
        )


def _normalize_permission_mode(value: object) -> PermissionMode | None:
    raw = str(value or "").strip().lower().replace(" ", "_")
    aliases = {
        "default": PermissionMode.DEFAULT,
        "permissionmode.default": PermissionMode.DEFAULT,
        "plan": PermissionMode.PLAN,
        "plan_mode": PermissionMode.PLAN,
        "permissionmode.plan": PermissionMode.PLAN,
        "full_auto": PermissionMode.FULL_AUTO,
        "auto": PermissionMode.FULL_AUTO,
        "permissionmode.full_auto": PermissionMode.FULL_AUTO,
    }
    return aliases.get(raw)
