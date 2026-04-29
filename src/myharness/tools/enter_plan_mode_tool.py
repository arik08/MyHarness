"""Tool for entering plan permission mode."""

from __future__ import annotations

from pydantic import BaseModel

from myharness.config.settings import load_settings, save_settings
from myharness.permissions import PermissionMode
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult


class EnterPlanModeToolInput(BaseModel):
    """No-op input model."""


class EnterPlanModeTool(BaseTool):
    """Switch settings permission mode to plan."""

    name = "enter_plan_mode"
    description = "Switch permission mode to plan."
    input_model = EnterPlanModeToolInput

    async def execute(self, arguments: EnterPlanModeToolInput, context: ToolExecutionContext) -> ToolResult:
        del arguments
        settings = load_settings()
        current_mode = _normalize_permission_mode(context.metadata.get("permission_mode"))
        if current_mode is None:
            current_mode = settings.permission.mode
        previous_mode = (
            settings.permission.plan_previous_mode
            if current_mode == PermissionMode.PLAN and settings.permission.plan_previous_mode is not None
            else current_mode
        )
        if previous_mode == PermissionMode.PLAN:
            previous_mode = PermissionMode.FULL_AUTO if settings.yolo_mode_enabled else PermissionMode.DEFAULT
        settings.permission.mode = PermissionMode.PLAN
        settings.permission.plan_previous_mode = previous_mode
        save_settings(settings)
        return ToolResult(
            output="Permission mode set to plan",
            metadata={
                "permission_mode": PermissionMode.PLAN.value,
                "plan_previous_permission_mode": previous_mode.value,
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
