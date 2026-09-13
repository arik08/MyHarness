from myharness.api.codex_client import _convert_tools_to_codex


def test_mcp_optional_singleton_enum_is_not_forced_by_responses_normalization():
    schema = {"type": "object", "properties": {
        "status": {"type": "string", "enum": ["all", "pending"]},
        "bill_type": {"type": "string", "enum": ["alternative"]},
    }}
    tool = _convert_tools_to_codex([{
        "name": "mcp__national-assembly__assembly_bill", "input_schema": schema,
    }])[0]
    assert tool["strict"] is False
    assert tool["parameters"] == schema
    assert "required" not in tool["parameters"]


def test_builtin_tool_contract_is_unchanged():
    tool = _convert_tools_to_codex([{"name": "read_file", "input_schema": {}}])[0]
    assert "strict" not in tool
