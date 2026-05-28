"""Tests for the EIA Open Data MCP server."""

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


def _load_eia_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "eia_server.py"
    spec = importlib.util.spec_from_file_location("eia_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_get_series_uses_seriesid_endpoint_and_api_key(monkeypatch) -> None:
    eia_server = _load_eia_server()
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
                "response": {
                    "total": 1,
                    "data": [
                        {
                            "period": "2026-05-18",
                            "series-description": "Cushing, OK WTI Spot Price FOB",
                            "value": 112.25,
                            "units": "$/BBL",
                        }
                    ],
                }
            }

    def fake_get(url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, "kwargs": kwargs})
        return Response()

    monkeypatch.setenv("EIA_API_KEY", "test-key")
    monkeypatch.setattr(eia_server, "_httpx_verify_argument", lambda: verify_context)
    monkeypatch.setattr(eia_server.httpx, "get", fake_get)

    rows = json.loads(eia_server.get_series("PET.RWTC.D", length=1))

    assert rows[0]["value"] == 112.25
    assert calls[0]["url"] == "https://api.eia.gov/v2/seriesid/PET.RWTC.D"
    assert calls[0]["kwargs"]["params"]["api_key"] == "test-key"
    assert calls[0]["kwargs"]["verify"] is verify_context


def test_get_energy_price_uses_known_series_id(monkeypatch) -> None:
    eia_server = _load_eia_server()
    calls: list[str] = []

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {"response": {"data": [{"period": "2026-05-18", "value": 1}]}}

    def fake_get(url: str, **kwargs: Any) -> Response:
        del kwargs
        calls.append(url)
        return Response()

    monkeypatch.setenv("EIA_API_KEY", "test-key")
    monkeypatch.setattr(eia_server.httpx, "get", fake_get)

    eia_server.get_energy_price("wti", length=1)

    assert calls[0].endswith("/seriesid/PET.RWTC.D")


def test_missing_api_key_has_clear_error(monkeypatch) -> None:
    eia_server = _load_eia_server()
    monkeypatch.delenv("EIA_API_KEY", raising=False)

    with pytest.raises(ValueError, match="EIA_API_KEY"):
        eia_server.get_series("PET.RWTC.D")


def test_eia_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["eia"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/eia_server.py"]
    assert server.cwd == "."
    assert server.env == {"EIA_API_KEY": "jMenIntSd7Mef51GX7yFhumWHsxDcJjL0y8xO1w5"}
