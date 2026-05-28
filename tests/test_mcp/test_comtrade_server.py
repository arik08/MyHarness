"""Tests for the UN Comtrade API MCP server."""

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


def _load_comtrade_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "comtrade_server.py"
    spec = importlib.util.spec_from_file_location("comtrade_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_preview_trade_data_uses_public_endpoint_and_corporate_ssl(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()
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
                "elapsedTime": "0.3 secs",
                "count": 1,
                "data": [{"reporterCode": 410, "period": "2023", "primaryValue": 123}],
                "error": "",
            }

    def fake_get(url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, "kwargs": kwargs})
        return Response()

    monkeypatch.setattr(comtrade_server, "_httpx_verify_argument", lambda: verify_context)
    monkeypatch.setattr(comtrade_server.httpx, "get", fake_get)

    output = comtrade_server.preview_trade_data(
        reporter_code="410",
        period="2023",
        cmd_code="TOTAL",
        flow_code="X",
        partner_code="0",
        limit=1,
    )

    payload = json.loads(output)
    assert payload["data"][0]["primaryValue"] == 123
    assert calls[0]["url"] == "https://comtradeapi.un.org/public/v1/preview/C/A/HS"
    assert calls[0]["kwargs"]["verify"] is verify_context
    assert calls[0]["kwargs"]["params"]["reporterCode"] == "410"
    assert calls[0]["kwargs"]["params"]["includeDesc"] == "true"


def test_get_trade_data_requires_api_key_for_data_endpoint(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()
    monkeypatch.delenv("UN_COMTRADE_API_KEY", raising=False)
    monkeypatch.delenv("COMTRADE_API_KEY", raising=False)

    with pytest.raises(ValueError, match="UN_COMTRADE_API_KEY"):
        comtrade_server.get_trade_data(reporter_code="410", period="2023")


def test_get_trade_data_uses_subscription_key_header(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()
    calls: list[dict[str, Any]] = []

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {"count": 0, "data": [], "error": ""}

    def fake_get(url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, "kwargs": kwargs})
        return Response()

    monkeypatch.setenv("UN_COMTRADE_API_KEY", "secret-key")
    monkeypatch.setattr(comtrade_server.httpx, "get", fake_get)

    comtrade_server.get_trade_data(reporter_code="410", period="2023")

    assert calls[0]["url"] == "https://comtradeapi.un.org/data/v1/get/C/A/HS"
    assert calls[0]["kwargs"]["headers"]["Ocp-Apim-Subscription-Key"] == "secret-key"


def test_get_trade_data_falls_back_to_secondary_key(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()
    calls: list[dict[str, Any]] = []

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {"count": 0, "data": [], "error": ""}

    def fake_get(url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, "kwargs": kwargs})
        return Response()

    monkeypatch.delenv("UN_COMTRADE_API_KEY", raising=False)
    monkeypatch.delenv("COMTRADE_API_KEY", raising=False)
    monkeypatch.setenv("UN_COMTRADE_SECONDARY_API_KEY", "secondary-key")
    monkeypatch.setattr(comtrade_server.httpx, "get", fake_get)

    comtrade_server.get_trade_data(reporter_code="410", period="2023")

    assert calls[0]["kwargs"]["headers"]["Ocp-Apim-Subscription-Key"] == "secondary-key"


def test_search_reporters_filters_reference_file(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {
                "results": [
                    {"reporterCode": 410, "reporterDesc": "Rep. of Korea", "reporterCodeIsoAlpha3": "KOR"},
                    {"reporterCode": 842, "reporterDesc": "USA", "reporterCodeIsoAlpha3": "USA"},
                ]
            }

    monkeypatch.setattr(comtrade_server.httpx, "get", lambda *args, **kwargs: Response())

    rows = json.loads(comtrade_server.search_reporters("korea"))

    assert rows == [
        {"reporterCode": 410, "reporterDesc": "Rep. of Korea", "reporterCodeIsoAlpha3": "KOR"}
    ]


def test_api_protocol_can_be_switched_for_company_network(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()
    calls: list[str] = []

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {"count": 0, "data": [], "error": ""}

    def fake_get(url: str, **kwargs: Any) -> Response:
        del kwargs
        calls.append(url)
        return Response()

    monkeypatch.setenv("UN_COMTRADE_API_PROTOCOL", "http")
    monkeypatch.setattr(comtrade_server.httpx, "get", fake_get)

    comtrade_server.preview_trade_data(reporter_code="410", period="2023")

    assert calls[0].startswith("http://comtradeapi.un.org/")


def test_transient_network_error_is_retried(monkeypatch) -> None:
    comtrade_server = _load_comtrade_server()
    calls = 0

    class Response:
        status_code = 200
        headers = {"content-type": "application/json"}
        text = ""

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return {"count": 0, "data": [], "error": ""}

    def fake_get(*args: Any, **kwargs: Any) -> Response:
        del args, kwargs
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("temporary proxy reset")
        return Response()

    monkeypatch.setattr(comtrade_server, "_retry_sleep", lambda _attempt: None, raising=False)
    monkeypatch.setattr(comtrade_server.httpx, "get", fake_get)

    comtrade_server.preview_trade_data(reporter_code="410", period="2023")

    assert calls == 2


def test_comtrade_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["comtrade"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/comtrade_server.py"]
    assert server.cwd == "."
    assert server.env == {
        "UN_COMTRADE_API_KEY": "785399a0da8c404982634f0da4dbcda1",
        "UN_COMTRADE_SECONDARY_API_KEY": "c31f0aa100164237bf218e288bf79a03",
    }
