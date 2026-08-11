"""Tests for the development-finance MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from myharness.mcp.config import load_mcp_configs_from_dirs


def _load_server() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / ".skills" / "mcp" / "development-finance" / "runtime" / "server.py"
    spec = importlib.util.spec_from_file_location("development_finance_server_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_adb_catalog_is_locally_filtered(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *args, **kwargs: [
            {"code": "NGDP_XDC", "name": "Gross domestic product"},
            {"code": "POP", "name": "Population"},
        ],
    )

    result = json.loads(module.search_catalog("adb", "EO_NA", "domestic"))

    assert result["data"] == [{"code": "NGDP_XDC", "name": "Gross domestic product"}]


def test_adb_series_uses_bounded_sdmx_csv(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = b"DATAFLOW,FREQ,INDICATOR,ECONOMY_CODE,TIME_PERIOD,OBS_VALUE,UNIT\nADB:EO_NA(1.0),A,NGDP_XDC,PHI,2024,26446.3,P\n"

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, **kwargs})
        return Response()

    monkeypatch.setattr(module, "request", fake_request)
    result = json.loads(module.query_series("adb", "EO_NA", "NGDP_XDC", "PHI", 2024, 2024))

    assert calls[0]["url"].endswith("/ADB,EO_NA/A.NGDP_XDC.PHI")
    assert calls[0]["params"]["format"] == "sdmx-csv"
    assert result["data"][0]["OBS_VALUE"] == "26446.3"


def test_adb_series_rejects_more_than_twenty_codes() -> None:
    module = _load_server()
    codes = "+".join(f"C{i}" for i in range(21))

    try:
        module.query_series("adb", "EO_NA", codes, "PHI")
    except ValueError as exc:
        assert "indicators" in str(exc)
    else:
        raise AssertionError("more than 20 codes should be rejected")


def test_config_loads_without_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"
    config = load_mcp_configs_from_dirs([mcp_dir])["development-finance"]

    assert config.env is None
    assert config.args == ["runtime/server.py"]


def test_adb_series_requires_bounded_ordered_period() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="start_period and end_period"):
        module.query_series("adb", "EO_NA", "NGDP_XDC", "PHI")
    with pytest.raises(ValueError, match="earlier"):
        module.query_series("adb", "EO_NA", "NGDP_XDC", "PHI", 2025, 2024)


def test_adb_health_converts_probe_failure_to_health_json(monkeypatch) -> None:
    module = _load_server()

    def fail(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(module, "request_json", fail)
    result = json.loads(module.get_source_health("adb"))

    assert result["ok"] is False
    assert "RuntimeError" in result["detail"]
