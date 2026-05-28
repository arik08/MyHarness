"""Tests for the Bank of Korea ECOS MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import httpx
import pytest

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


def _load_ecos_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "ecos_server.py"
    spec = importlib.util.spec_from_file_location("ecos_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_get_exchange_rate_uses_ecos_statistic_search(monkeypatch) -> None:
    ecos_server = _load_ecos_server()
    verify_context = object()
    calls: list[dict[str, Any]] = []

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {
                "StatisticSearch": {
                    "list_total_count": 1,
                    "row": [
                        {
                            "STAT_CODE": "731Y001",
                            "ITEM_CODE1": "0000001",
                            "ITEM_NAME1": "원/미국달러(매매기준율)",
                            "UNIT_NAME": "원",
                            "TIME": "20240502",
                            "DATA_VALUE": "1378",
                        }
                    ],
                }
            }

    def fake_get(url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, "kwargs": kwargs})
        return Response()

    monkeypatch.setenv("ECOS_API_KEY", "test-key")
    monkeypatch.setattr(ecos_server, "_httpx_verify_argument", lambda: verify_context)
    monkeypatch.setattr(ecos_server.httpx, "get", fake_get)

    rows = json.loads(ecos_server.get_exchange_rate("USD", "20240501", "20240503"))

    assert rows[0]["DATA_VALUE"] == "1378"
    assert calls[0]["url"].endswith("/StatisticSearch/test-key/json/kr/1/1000/731Y001/D/20240501/20240503/0000001")
    assert calls[0]["kwargs"]["verify"] is verify_context


def test_search_statistics_returns_rows(monkeypatch) -> None:
    ecos_server = _load_ecos_server()

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {"StatisticTableList": {"row": [{"STAT_CODE": "731Y001", "STAT_NAME": "환율"}]}}

    monkeypatch.setenv("ECOS_API_KEY", "test-key")
    monkeypatch.setattr(ecos_server.httpx, "get", lambda *args, **kwargs: Response())

    rows = json.loads(ecos_server.list_stat_tables())

    assert rows == [{"STAT_CODE": "731Y001", "STAT_NAME": "환율"}]


def test_missing_api_key_has_clear_error(monkeypatch) -> None:
    ecos_server = _load_ecos_server()
    monkeypatch.delenv("ECOS_API_KEY", raising=False)
    monkeypatch.delenv("BOK_ECOS_API_KEY", raising=False)

    with pytest.raises(ValueError, match="ECOS_API_KEY"):
        ecos_server.get_key_statistics()


def test_ecos_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["ecos"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/ecos_server.py"]
    assert server.cwd == "."
    assert server.env == {"ECOS_API_KEY": "IAY2CU4G4W24KJC0UHRM"}
