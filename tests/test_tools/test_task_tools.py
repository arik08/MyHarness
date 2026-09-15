"""Tests for task and team tools."""

from __future__ import annotations

import asyncio
from pathlib import Path

import pytest

from myharness.subagents import SUBAGENT_INVOCATION_DISABLED_MESSAGE
from myharness.tasks.manager import TASK_PROGRESS_EVENT_PREFIX
from myharness.tasks import get_task_manager
from myharness.tools import create_default_tool_registry
from myharness.tools.agent_tool import AgentTool, AgentToolInput
from myharness.tools.base import ToolExecutionContext
from myharness.tools.task_create_tool import TaskCreateTool, TaskCreateToolInput
from myharness.tools.task_output_tool import TaskOutputTool, TaskOutputToolInput
from myharness.tools.task_update_tool import TaskUpdateTool, TaskUpdateToolInput
from myharness.tools.team_create_tool import TeamCreateTool, TeamCreateToolInput


async def _wait_for_terminal_task(task_id: str, *, timeout_seconds: float = 2.0) -> None:
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    manager = get_task_manager()
    while asyncio.get_running_loop().time() < deadline:
        task = manager.get_task(task_id)
        if task is not None and task.status in {"completed", "failed", "killed"}:
            return
        await asyncio.sleep(0.05)
    raise AssertionError(f"Task {task_id} did not reach a terminal status in time")


@pytest.mark.asyncio
async def test_task_create_and_output_tool(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    context = ToolExecutionContext(cwd=tmp_path)

    create_result = await TaskCreateTool().execute(
        TaskCreateToolInput(
            type="local_bash",
            description="echo",
            command="printf 'tool task'",
        ),
        context,
    )
    assert create_result.is_error is False
    task_id = create_result.output.split()[2]

    manager = get_task_manager()
    for _ in range(20):
        if "tool task" in manager.read_task_output(task_id):
            break
        await asyncio.sleep(0.1)
    output_result = await TaskOutputTool().execute(
        TaskOutputToolInput(task_id=task_id),
        context,
    )
    assert "tool task" in output_result.output


@pytest.mark.asyncio
async def test_task_create_tool_reports_process_start_errors(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    context = ToolExecutionContext(cwd=tmp_path / "missing")

    result = await TaskCreateTool().execute(
        TaskCreateToolInput(
            type="local_bash",
            description="bad cwd",
            command="printf 'never starts'",
        ),
        context,
    )

    assert result.is_error is True
    assert result.output


@pytest.mark.asyncio
async def test_task_create_tool_blocks_local_agent_tasks(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))

    result = await TaskCreateTool().execute(
        TaskCreateToolInput(type="local_agent", description="agent", prompt="hi"),
        ToolExecutionContext(cwd=tmp_path),
    )

    assert result.is_error is True
    assert result.output == SUBAGENT_INVOCATION_DISABLED_MESSAGE
    assert get_task_manager().list_tasks() == []


def test_default_tool_registry_hides_subagent_invocation_tools():
    registry = create_default_tool_registry()

    for name in ("agent", "send_message", "team_create", "team_delete"):
        assert registry.get(name) is None
    assert registry.get("task_create") is not None


@pytest.mark.asyncio
async def test_team_create_tool(tmp_path: Path):
    result = await TeamCreateTool().execute(
        TeamCreateToolInput(name="demo", description="test"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert result.is_error is False
    assert "Created team demo" == result.output


@pytest.mark.asyncio
async def test_task_update_tool_updates_metadata(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    context = ToolExecutionContext(cwd=tmp_path)

    create_result = await TaskCreateTool().execute(
        TaskCreateToolInput(
            type="local_bash",
            description="updatable",
            command="printf 'tool task'",
        ),
        context,
    )
    task_id = create_result.output.split()[2]

    update_result = await TaskUpdateTool().execute(
        TaskUpdateToolInput(
            task_id=task_id,
            progress=60,
            status_note="waiting on verification",
            description="renamed task",
        ),
        context,
    )
    assert update_result.is_error is False

    task = get_task_manager().get_task(task_id)
    assert task is not None
    assert task.description == "renamed task"
    assert task.metadata["progress"] == "60"
    assert task.metadata["status_note"] == "waiting on verification"
    assert float(task.metadata["status_note_updated_at"]) > 0


def test_task_update_tool_is_read_only_for_project_mutation_lock():
    tool = TaskUpdateTool()

    assert tool.is_read_only(TaskUpdateToolInput(task_id="a123", status_note="진행 중")) is True
    assert tool.requires_project_mutation_lock(
        TaskUpdateToolInput(task_id="a123", status_note="진행 중")
    ) is False


def test_coordination_tools_do_not_take_project_mutation_lock():
    from myharness.tools.send_message_tool import SendMessageTool, SendMessageToolInput
    from myharness.tools.task_stop_tool import TaskStopTool, TaskStopToolInput
    from myharness.tools.team_delete_tool import TeamDeleteTool, TeamDeleteToolInput

    assert TeamCreateTool().requires_project_mutation_lock(
        TeamCreateToolInput(name="office")
    ) is False
    assert TeamDeleteTool().requires_project_mutation_lock(
        TeamDeleteToolInput(name="office")
    ) is False
    assert SendMessageTool().requires_project_mutation_lock(
        SendMessageToolInput(task_id="a123", message="ping")
    ) is False
    assert TaskStopTool().requires_project_mutation_lock(TaskStopToolInput(task_id="a123")) is False
    assert TaskCreateTool().requires_project_mutation_lock(
        TaskCreateToolInput(type="local_agent", description="agent", prompt="hi")
    ) is False
    assert TaskCreateTool().requires_project_mutation_lock(
        TaskCreateToolInput(type="local_bash", description="bash", command="echo hi")
    ) is True


@pytest.mark.asyncio
async def test_task_update_tool_emits_parent_progress_when_worker_cannot_see_task(
    tmp_path: Path,
    monkeypatch,
    capsys,
):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    monkeypatch.setenv("MYHARNESS_PARENT_TASK_ID", "a-parent")

    result = await TaskUpdateTool().execute(
        TaskUpdateToolInput(
            task_id="a-parent",
            progress=75,
            status_note="출처 검증 중",
            description="조사 담당: 출처 검증",
        ),
        ToolExecutionContext(cwd=tmp_path),
    )

    captured = capsys.readouterr()
    assert result.is_error is False
    assert result.output == "Updated task a-parent"
    assert captured.out.startswith(TASK_PROGRESS_EVENT_PREFIX)
    assert '"task_id":"a-parent"' in captured.out
    assert '"progress":75' in captured.out


@pytest.mark.asyncio
async def test_agent_tool_blocks_direct_subagent_invocation(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))

    result = await AgentTool().execute(
        AgentToolInput(
            description="조사 담당",
            prompt="자료 확인",
            subagent_type="worker",
            command='python -u -c "import sys; print(sys.stdin.readline().strip())"',
        ),
        ToolExecutionContext(cwd=tmp_path),
    )

    assert result.is_error is True
    assert result.output == SUBAGENT_INVOCATION_DISABLED_MESSAGE
    assert get_task_manager().list_tasks() == []


def test_agent_tool_skips_project_mutation_lock_without_being_read_only():
    tool = AgentTool()
    args = AgentToolInput(description="조사 담당", prompt="자료 확인")

    assert tool.is_read_only(args) is False
    assert tool.requires_project_mutation_lock(args) is False


def test_task_worker_registry_keeps_progress_tool_without_parent_task_queries():
    registry = create_default_tool_registry(task_worker=True)

    assert registry.get("task_update") is not None
    for name in (
        "task_create",
        "task_get",
        "task_list",
        "task_stop",
        "task_output",
        "agent",
        "send_message",
        "team_create",
        "team_delete",
    ):
        assert registry.get(name) is None


@pytest.mark.asyncio
async def test_send_message_swarm_path_uses_subprocess_backend(
    tmp_path: Path, monkeypatch
):
    """SendMessageTool._send_swarm_message must route via SubprocessBackend.

    Before the fix, _send_swarm_message also hardcoded in_process, so even
    the name@team routing path would fail to find agents spawned by AgentTool.
    """
    from unittest.mock import AsyncMock, patch

    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    context = ToolExecutionContext(cwd=tmp_path)

    from myharness.tools.send_message_tool import SendMessageTool

    with patch(
        "myharness.swarm.subprocess_backend.SubprocessBackend.send_message",
        new_callable=AsyncMock,
    ) as mock_send:
        await SendMessageTool().execute(
            __import__(
                "myharness.tools.send_message_tool",
                fromlist=["SendMessageToolInput"],
            ).SendMessageToolInput(
                task_id="worker@default",
                message="ping",
            ),
            context,
        )

    # send_message may raise ValueError because no agent was spawned yet
    # (no _agent_tasks entry), but the key assertion is that SubprocessBackend
    # was called — not InProcessBackend.
    mock_send.assert_called_once()
    agent_id_arg = mock_send.call_args[0][0]
    assert agent_id_arg == "worker@default"


def test_send_message_input_accepts_to_alias():
    from myharness.tools.send_message_tool import SendMessageToolInput

    args = SendMessageToolInput.model_validate(
        {"to": "worker@default", "message": "ping"}
    )

    assert args.task_id == "worker@default"
    assert args.message == "ping"
