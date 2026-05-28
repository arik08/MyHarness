"""Tests for the World Bank API MCP server."""

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


def _load_worldbank_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "worldbank_server.py"
    spec = importlib.util.spec_from_file_location("worldbank_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fetch_indicator_data_pages_and_uses_corporate_ssl(monkeypatch) -> None:
    worldbank_server = _load_worldbank_server()
    verify_context = object()
    calls: list[dict[str, Any]] = []

    class Response:
        def __init__(self, payload: object) -> None:
            self._payload = payload

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return self._payload

    def fake_get(url: str, **kwargs: Any) -> Response:
        calls.append({"url": url, "kwargs": kwargs})
        page = kwargs["params"]["page"]
        payloads = {
            1: [
                {"page": 1, "pages": 2, "per_page": 1, "total": 2},
                [{"countryiso3code": "KOR", "date": "2024", "value": 1}],
            ],
            2: [
                {"page": 2, "pages": 2, "per_page": 1, "total": 2},
                [{"countryiso3code": "KOR", "date": "2023", "value": 2}],
            ],
        }
        return Response(payloads[page])

    monkeypatch.setattr(worldbank_server, "_httpx_verify_argument", lambda: verify_context)
    monkeypatch.setattr(worldbank_server.httpx, "get", fake_get)

    output = worldbank_server.fetch_indicator_data(
        country="KOR",
        indicator="NY.GDP.MKTP.CD",
        start_year=2023,
        end_year=2024,
        limit=2,
    )

    rows = json.loads(output)
    assert [row["date"] for row in rows] == ["2024", "2023"]
    assert calls[0]["url"] == "https://api.worldbank.org/v2/country/KOR/indicator/NY.GDP.MKTP.CD"
    assert calls[0]["kwargs"]["verify"] is verify_context
    assert calls[0]["kwargs"]["params"]["date"] == "2023:2024"
    assert calls[0]["kwargs"]["params"]["format"] == "json"


def test_search_indicators_filters_api_results(monkeypatch) -> None:
    worldbank_server = _load_worldbank_server()

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return [
                {"page": 1, "pages": 1, "per_page": 10, "total": 2},
                [
                    {
                        "id": "NY.GDP.MKTP.CD",
                        "name": "GDP (current US$)",
                        "sourceNote": "Gross domestic product in current U.S. dollars.",
                    },
                    {
                        "id": "SP.POP.TOTL",
                        "name": "Population, total",
                        "sourceNote": "Total population.",
                    },
                ],
            ]

    monkeypatch.setattr(worldbank_server.httpx, "get", lambda *args, **kwargs: Response())

    rows = json.loads(worldbank_server.search_indicators("gdp", limit=10))

    assert [row["id"] for row in rows] == ["NY.GDP.MKTP.CD"]


def test_api_protocol_can_be_switched_to_http_for_company_network(monkeypatch) -> None:
    worldbank_server = _load_worldbank_server()
    calls: list[str] = []

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return [{"page": 1, "pages": 1, "per_page": 1, "total": 0}, []]

    def fake_get(url: str, **kwargs: Any) -> Response:
        del kwargs
        calls.append(url)
        return Response()

    monkeypatch.setenv("WORLD_BANK_API_PROTOCOL", "http")
    monkeypatch.setattr(worldbank_server.httpx, "get", fake_get)

    worldbank_server.fetch_indicator_data(country="KOR", indicator="SP.POP.TOTL", limit=1)

    assert calls[0].startswith("http://api.worldbank.org/v2/")


def test_non_json_proxy_response_has_actionable_error(monkeypatch) -> None:
    worldbank_server = _load_worldbank_server()

    class Response:
        status_code = 200
        headers = {"content-type": "text/html"}
        text = "<html>Corporate proxy block page</html>"

        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            raise ValueError("not json")

    monkeypatch.setattr(worldbank_server.httpx, "get", lambda *args, **kwargs: Response())

    with pytest.raises(RuntimeError, match="non-JSON.*company proxy"):
        worldbank_server.fetch_indicator_data(country="KOR", indicator="SP.POP.TOTL", limit=1)


def test_transient_network_error_is_retried(monkeypatch) -> None:
    worldbank_server = _load_worldbank_server()
    calls = 0

    class Response:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> object:
            return [
                {"page": 1, "pages": 1, "per_page": 1, "total": 1},
                [{"countryiso3code": "KOR", "date": "2023", "value": 51712619}],
            ]

    def fake_get(*args: Any, **kwargs: Any) -> Response:
        del args, kwargs
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("temporary proxy reset")
        return Response()

    monkeypatch.setattr(worldbank_server, "_retry_sleep", lambda _attempt: None, raising=False)
    monkeypatch.setattr(worldbank_server.httpx, "get", fake_get)

    rows = json.loads(
        worldbank_server.fetch_indicator_data(country="KOR", indicator="SP.POP.TOTL", limit=1)
    )

    assert calls == 2
    assert rows[0]["value"] == 51712619


def test_worldbank_config_is_loaded_as_stdio_server() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    server = configs["worldbank"]
    assert isinstance(server, McpStdioServerConfig)
    assert server.command == "python"
    assert server.args == [".mcp/worldbank_server.py"]
    assert server.cwd == "."
