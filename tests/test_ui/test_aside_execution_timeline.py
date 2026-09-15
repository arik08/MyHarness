"""Real local tool execution through the public workflow transport."""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from myharness.api.client import ApiMessageCompleteEvent, ApiTextDeltaEvent
from myharness.api.usage import UsageSnapshot
from myharness.engine.messages import ConversationMessage, TextBlock, ToolUseBlock
from myharness.ui.backend_host import BackendHostConfig, ReactBackendHost
from myharness.ui.execution_display import execution_display_value
from myharness.ui.protocol import BackendEvent
from myharness.ui.runtime import build_runtime, close_runtime, start_runtime


def test_execution_display_redacts_nested_credentials_without_mutation():
    original = {"api_key": "key-value", "nested": [{"ACCESS_TOKEN": "token-value"}], "command": "curl -H 'Authorization: Bearer secret-value'", "output": "query=visible"}
    safe = execution_display_value(original)
    assert original["api_key"] == "key-value"
    assert "key-value" not in json.dumps(safe)
    assert "token-value" not in json.dumps(safe)
    assert "secret-value" not in json.dumps(safe)
    assert safe["output"] == "query=visible"


def test_progress_and_agent_history_keep_their_turn_boundaries():
    host = ReactBackendHost(BackendHostConfig())
    host._record_history_event(BackendEvent(type="status", message="연결 중"))
    assert not host._history_events
    host._record_history_event(BackendEvent(type="status", progress_source="assistant", message="자료를 확인합니다."))
    host._record_history_event(BackendEvent(type="swarm_status", swarm_teammates=[{"id": "a", "status": "running"}]))
    host._append_history_event({"type": "user", "text": "다음 작업"})
    host._record_history_event(BackendEvent(type="swarm_status", swarm_teammates=[{"id": "b", "status": "completed"}]))
    assert [event["type"] for event in host._history_events] == ["progress_note", "swarm_status", "user", "swarm_status"]


@pytest.mark.asyncio
async def test_shell_streams_actual_output_then_persists_complete_execution(tmp_path, monkeypatch, capfd):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("MYHARNESS_CONFIG_DIR", str(tmp_path / "config"))
    monkeypatch.setenv("MYHARNESS_DATA_DIR", str(tmp_path / "data"))
    (tmp_path / "evidence.txt").write_text("확인된 로컬 자료입니다.", encoding="utf-8")
    command = 'python -u -c "import time; print(\'FIRST\', flush=True); time.sleep(0.35); print(\'SECOND\', flush=True)"'
    note = '<myharness-progress>{"message":"파일과 실제 명령 출력을 확인하겠습니다."}</myharness-progress>'

    class ScriptedProvider:
        turns = 0

        async def stream_message(self, request):
            self.turns += 1
            if self.turns == 1:
                yield ApiTextDeltaEvent(text=note[:45])
                yield ApiTextDeltaEvent(text=note[45:])
                content = [TextBlock(text=note), ToolUseBlock(id="aside-shell", name="cmd", input={"command": command}), ToolUseBlock(id="aside-read", name="read_file", input={"path": str(tmp_path / "evidence.txt")})]
            else:
                content = [TextBlock(text="로컬 파일 조회와 명령 실행을 검증했습니다.")]
            yield ApiMessageCompleteEvent(message=ConversationMessage(role="assistant", content=content), usage=UsageSnapshot(input_tokens=2, output_tokens=3), stop_reason=None)

    client = ScriptedProvider()
    host = ReactBackendHost(BackendHostConfig(api_client=client, cwd=str(tmp_path)))
    host._bundle = await build_runtime(api_client=client, cwd=str(tmp_path), permission_mode="full_auto")
    await start_runtime(host._bundle)
    try:
        await host._process_line("로컬 파일과 명령을 확인해주세요")
    finally:
        await close_runtime(host._bundle)
    transport = capfd.readouterr().out
    events = []
    for line in transport.splitlines():
        start = line.find("OHJSON:")
        if start >= 0:
            events.append(json.loads(line[start + len("OHJSON:"):]))
    shell = [event for event in events if event.get("tool_call_id") == "aside-shell"]
    capture_path = os.environ.get("MYHARNESS_ASIDE_CAPTURE")
    if capture_path:
        Path(capture_path).write_text(json.dumps({"events": events, "history_events": host._history_events}, ensure_ascii=False, indent=2), encoding="utf-8")
    partial = next(event for event in shell if event["type"] == "tool_progress" and "FIRST" in (event.get("output") or "") and "SECOND" not in (event.get("output") or ""))
    complete = next(event for event in shell if event["type"] == "tool_completed")
    assert shell.index(partial) < shell.index(complete)
    assert "SECOND" in complete["output"]
    assert complete["execution_metadata"]["returncode"] == 0
    assert complete["execution_metadata"]["cwd"] == str(tmp_path)
    assert any(event["type"] == "progress_note" for event in host._history_events)
    saved = next(event for event in host._history_events if event["type"] == "tool_completed" and event.get("tool_call_id") == "aside-shell")
    assert saved["output"] == complete["output"]
    assert saved["execution_metadata"]["returncode"] == 0
    assert saved["timestamp"] > 0
    assert not any(event.get("type") == "assistant" and "myharness-progress" in event.get("text", "") for event in host._history_events)
    capture_path = os.environ.get("MYHARNESS_ASIDE_CAPTURE")
    if capture_path:
        Path(capture_path).write_text(json.dumps({"events": events, "history_events": host._history_events}, ensure_ascii=False, indent=2), encoding="utf-8")
