"""Built-in tool registration."""

from myharness.tools.ask_user_question_tool import AskUserQuestionTool
from myharness.tools.agent_tool import AgentTool
from myharness.platforms import get_platform
from myharness.tools.bash_tool import BashTool, CmdTool
from myharness.tools.base import BaseTool, ToolExecutionContext, ToolRegistry, ToolResult
from myharness.tools.brief_tool import BriefTool
from myharness.tools.config_tool import ConfigTool
from myharness.tools.cron_create_tool import CronCreateTool
from myharness.tools.cron_delete_tool import CronDeleteTool
from myharness.tools.cron_list_tool import CronListTool
from myharness.tools.cron_toggle_tool import CronToggleTool
from myharness.tools.enter_plan_mode_tool import EnterPlanModeTool
from myharness.tools.enter_worktree_tool import EnterWorktreeTool
from myharness.tools.exit_plan_mode_tool import ExitPlanModeTool
from myharness.tools.exit_worktree_tool import ExitWorktreeTool
from myharness.tools.file_edit_tool import FileEditTool
from myharness.tools.file_read_tool import FileReadTool
from myharness.tools.file_write_tool import FileWriteTool
from myharness.tools.glob_tool import GlobTool
from myharness.tools.grep_tool import GrepTool
from myharness.tools.image_generation_tool import ImageGenerationTool
from myharness.tools.list_mcp_resources_tool import ListMcpResourcesTool
from myharness.tools.lsp_tool import LspTool
from myharness.tools.mcp_auth_tool import McpAuthTool
from myharness.tools.mcp_tool import McpToolAdapter
from myharness.tools.notebook_edit_tool import NotebookEditTool
from myharness.tools.read_mcp_resource_tool import ReadMcpResourceTool
from myharness.tools.remote_trigger_tool import RemoteTriggerTool
from myharness.tools.send_message_tool import SendMessageTool
from myharness.tools.skill_tool import SkillTool
from myharness.tools.sleep_tool import SleepTool
from myharness.tools.task_create_tool import TaskCreateTool
from myharness.tools.task_get_tool import TaskGetTool
from myharness.tools.task_list_tool import TaskListTool
from myharness.tools.task_output_tool import TaskOutputTool
from myharness.tools.task_stop_tool import TaskStopTool
from myharness.tools.task_update_tool import TaskUpdateTool
from myharness.tools.team_create_tool import TeamCreateTool
from myharness.tools.team_delete_tool import TeamDeleteTool
from myharness.tools.todo_write_tool import TodoWriteTool
from myharness.tools.tool_search_tool import ToolSearchTool
from myharness.tools.web_fetch_tool import WebFetchTool
from myharness.tools.web_search_tool import WebSearchTool


def create_default_tool_registry(mcp_manager=None, *, task_worker: bool = False) -> ToolRegistry:
    """Return the default built-in tool registry."""
    registry = ToolRegistry()
    command_tool = CmdTool() if get_platform() == "windows" else BashTool()
    task_tools = (
        (TaskUpdateTool(),)
        if task_worker
        else (
            TaskCreateTool(),
            TaskGetTool(),
            TaskListTool(),
            TaskStopTool(),
            TaskOutputTool(),
            TaskUpdateTool(),
        )
    )
    coordination_tools = (
        ()
        if task_worker
        else (
            AgentTool(),
            SendMessageTool(),
            TeamCreateTool(),
            TeamDeleteTool(),
        )
    )
    for tool in (
        command_tool,
        AskUserQuestionTool(),
        FileReadTool(),
        FileWriteTool(),
        FileEditTool(),
        NotebookEditTool(),
        LspTool(),
        McpAuthTool(),
        GlobTool(),
        GrepTool(),
        ImageGenerationTool(),
        SkillTool(),
        ToolSearchTool(),
        WebFetchTool(),
        WebSearchTool(),
        ConfigTool(),
        BriefTool(),
        SleepTool(),
        EnterWorktreeTool(),
        ExitWorktreeTool(),
        TodoWriteTool(),
        EnterPlanModeTool(),
        ExitPlanModeTool(),
        CronCreateTool(),
        CronListTool(),
        CronDeleteTool(),
        CronToggleTool(),
        RemoteTriggerTool(),
        *task_tools,
        *coordination_tools,
    ):
        registry.register(tool)
    if mcp_manager is not None:
        registry.register(ListMcpResourcesTool(mcp_manager))
        registry.register(ReadMcpResourceTool(mcp_manager))
        for tool_info in mcp_manager.list_tools():
            registry.register(McpToolAdapter(mcp_manager, tool_info))
    return registry


__all__ = [
    "BaseTool",
    "ToolExecutionContext",
    "ToolRegistry",
    "ToolResult",
    "create_default_tool_registry",
]
