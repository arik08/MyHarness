"""Guard against live audit false positives and running with the wrong settings."""
import importlib.util
from pathlib import Path

import pytest


@pytest.fixture
def audit_module(monkeypatch):
    scripts = Path(__file__).resolve().parents[2] / "scripts"
    monkeypatch.syspath_prepend(str(scripts))
    spec = importlib.util.spec_from_file_location("mcp_audit_under_test", scripts / "verify_all_mcps.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_audit_uses_web_local_env_and_settings(audit_module, monkeypatch, tmp_path):
    monkeypatch.setenv("MCP_AUDIT_TEST_KEY", "inherited")
    monkeypatch.delenv("MYHARNESS_CONFIG_DIR", raising=False)
    (tmp_path / "myharness.local.env").write_text("MCP_AUDIT_TEST_KEY=local\n", encoding="utf-8")
    (tmp_path / "API_KEY.env").write_text("MCP_AUDIT_TEST_KEY=key-file\n", encoding="utf-8")
    audit_module.load_web_environment(tmp_path)
    assert audit_module.os.environ["MCP_AUDIT_TEST_KEY"] == "key-file"
    assert audit_module.os.environ["MYHARNESS_CONFIG_DIR"] == str(tmp_path / ".myharness")


def test_audit_rejects_empty_samples_and_missing_penalty_body(audit_module):
    for text in ('{"ok": true, "sample_count": 0}', '{"data": []}', '[]'):
        with pytest.raises(AssertionError):
            audit_module.validate_output("worldbank", "check_connection", text)
    with pytest.raises(AssertionError, match="omitted"):
        audit_module.validate_output("korean-law", "legal_research", "처분 근거 확인: 시험법\n일반 법령 체계만 반환")
    # The word 'error' in quoted legislation is not a transport failure.
    audit_module.validate_output("korean-law", "legal_research", "법령 체계: 오류 정정에 관한 규정")


def test_audit_redacts_credential_in_query_and_path(audit_module):
    text = "https://example.test/private-value/json?api_key=private-value"
    assert "private-value" not in audit_module.redact(text, ["private-value"])
