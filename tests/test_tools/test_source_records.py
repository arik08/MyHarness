import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from pydantic import BaseModel

from myharness.tools.source_evidence import tool_source_records, source_record_instructions
from myharness.services.session_storage import _sanitize_history_events


def test_mcp_records_bind_each_url_to_its_own_content():
    output = json.dumps({"results": [{"url": "https://example.com/a", "text": "alpha 3억"},
                                      {"url": "https://example.com/b", "text": "beta 8억"}]})
    records = tool_source_records("mcp__new__search", {}, output, server="new", call_id="one")
    assert len(records) == 2
    assert "alpha" in records[0]["text"] and "beta" not in records[0]["text"]
    assert records[1]["url"].endswith("/b")
    other = tool_source_records("mcp__new__search", {}, output, server="new", call_id="two")
    assert records[0]["href"] != other[0]["href"]
    assert records[0]["href"] in source_record_instructions(records)


@pytest.mark.parametrize("output", ["기준금리 2.5%", '{"count":3}', '[{"name":"문서","amount":3}]'])
def test_mcp_without_urls_still_has_content(output):
    records = tool_source_records("read_mcp_resource", {"uri": "resource:doc"}, output, server="신규 서버", call_id="read")
    assert records[0]["text"]
    assert records[0]["server"] == "신규 서버"
    assert "MCP · 신규 서버" in source_record_instructions(records)


def test_web_content_survives_history_output_truncation():
    text = "앞부분 " * 1000 + "중요한 마지막 근거입니다."
    records = tool_source_records("web_fetch", {"url": "https://example.com/doc"}, text)
    events = _sanitize_history_events([{"type": "tool_completed", "tool_name": "web_fetch",
        "output": text, "execution_metadata": {"source_records": records}}], compact=True)
    assert len(events[0]["output"]) < len(text)
    assert "중요한 마지막 근거입니다." in events[0]["execution_metadata"]["source_records"][0]["text"]


def test_search_keeps_short_snippet():
    records = tool_source_records("web_search", {}, "1. 금리\nURL: https://example.com/rate\n2.5%")
    assert records[0]["origin"] == "web_search"
    assert "2.5%" in records[0]["text"]


def test_redirected_web_url_is_also_bound_to_content():
    records = tool_source_records("web_fetch", {"url": "https://example.com/old"},
                                  "URL: https://example.com/new\n상태: 200\n기준금리 2.5%")
    assert {r["href"] for r in records} == {"https://example.com/old", "https://example.com/new"}
    assert all("2.5%" in r["text"] for r in records)


@pytest.mark.parametrize("payload", [
    {"url": "https://example.com", "content": "신규 설비 투자는 3억 원입니다."},
    {"content": [{"type": "text", "text": '{"content":"신규 설비 투자는 3억 원입니다."}'}]},
    {"text": '```json\n{"content":"신규 설비 투자는 3억 원입니다."}\n```'},
])
def test_json_structure_is_not_shown_to_users(payload):
    records = tool_source_records("mcp__new__lookup", {}, json.dumps(payload, ensure_ascii=False), server="new", call_id="one")
    text = records[0]["text"]
    assert "신규 설비 투자는 3억 원입니다." in text
    assert "{" not in text and '"content"' not in text and "https://" not in text


@pytest.mark.asyncio
@pytest.mark.parametrize("is_error", [False, True])
async def test_engine_emits_source_records_and_model_references(tmp_path, is_error):
    from myharness.engine.query import QueryContext, _execute_tool_call
    from myharness.tools.base import BaseTool, ToolRegistry, ToolResult
    from myharness.permissions import PermissionChecker, PermissionMode
    from myharness.config.settings import PermissionSettings

    class Input(BaseModel):
        pass

    class Tool(BaseTool):
        name = "mcp__new__lookup"
        description = "test"
        input_model = Input
        _tool_info = SimpleNamespace(server_name="actual-name")

        def is_read_only(self, arguments):
            return True

        async def execute(self, arguments, context):
            return ToolResult(output="참고한 실제 내용입니다.", is_error=is_error)

    registry = ToolRegistry()
    registry.register(Tool())
    callback = AsyncMock()
    context = QueryContext(api_client=None, tool_registry=registry,
        permission_checker=PermissionChecker(PermissionSettings(mode=PermissionMode.FULL_AUTO)),
        cwd=tmp_path, model="test", system_prompt="test", max_tokens=1024, tool_metadata={"execution_output_callback": callback})
    result = await _execute_tool_call(context, "mcp__new__lookup", "call", {})
    if is_error:
        callback.assert_not_called()
        assert "source:mcp/" not in result.content
    else:
        records = callback.call_args.args[3]["source_records"]
        assert records[0]["text"] == "참고한 실제 내용입니다."
        assert records[0]["server"] == "actual-name"
        assert records[0]["href"] in result.content
