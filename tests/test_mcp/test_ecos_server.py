"""Tests for the Bank of Korea ECOS MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


def _load_ecos_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".skills" / "mcp" / "ecos" / "runtime" / "server.py"
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
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["ecos"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == ["runtime/server.py"]
    assert server.cwd == "."
    assert server.env == {"ECOS_API_KEY": "IAY2CU4G4W24KJC0UHRM"}


@pytest.mark.parametrize("cycle,start,end,normalized", [
    ("D", "2024-02-28", "2024-02-29", "20240228/20240229"),
    ("M", "2024-01", "2024-12", "202401/202412"),
    ("q", "2024q1", "2024q4", "2024Q1/2024Q4"),
])
def test_period_inputs_normalized_before_request(monkeypatch, cycle, start, end, normalized):
    module = _load_ecos_server()
    paths = []
    monkeypatch.setattr(module, "_api_key", lambda: "fixture")
    def request(path):
        paths.append(path)
        return {"StatisticSearch": {"row": [{"DATA_VALUE": "1"}]}}
    monkeypatch.setattr(module, "_request_json", request)
    assert json.loads(module.get_statistic_data("code", cycle, start, end))
    assert normalized in paths[0]


@pytest.mark.parametrize("cycle,start,end", [
    ("D", "240102", "240103"),
    ("D", "2023-02-29", "2023-03-01"), ("M", "2024-13", "2025-01"),
    ("Q", "2024Q0", "2024Q4"), ("A", "2025", "2024"),
])
def test_invalid_period_fails_before_credentials_or_network(cycle, start, end, monkeypatch):
    module = _load_ecos_server()
    monkeypatch.setattr(module, "_api_key", lambda: pytest.fail("must validate before credentials"))
    with pytest.raises(ValueError):
        module.get_statistic_data("code", cycle, start, end)
