"""Tests for the grouped trade-market MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from defusedxml.common import DefusedXmlException

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


def _load_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".skills" / "mcp" / "trade-market" / "runtime" / "server.py"
    spec = importlib.util.spec_from_file_location("trade_market_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_customs_query_uses_country_hs_and_parses_xml(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = b"""<response><header><resultCode>00</resultCode><resultMsg>OK</resultMsg></header>
        <body><items><item><year>2025.01</year><hsSgn>7208</hsSgn><expDlr>10</expDlr>
        <impDlr>20</impDlr></item></items></body></response>"""

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append({"source": source, "url": url, **kwargs})
        return Response()

    monkeypatch.setenv("KCS_TRADE_API_KEY", "encoded%2Bkey")
    monkeypatch.setattr(module, "request", fake_request)

    result_text = module.query_trade(
        "customs_kr",
        "both",
        "202501",
        "202502",
        product="7208",
        partner="US",
    )
    result = json.loads(result_text)

    assert result["data"][0]["hsSgn"] == "7208"
    assert calls[0]["params"]["serviceKey"] == "encoded+key"
    assert calls[0]["params"]["cntyCd"] == "US"
    assert "encoded%2Bkey" not in result_text


def test_customs_rejects_more_than_twelve_months(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("KCS_TRADE_API_KEY", "test-key")

    with pytest.raises(ValueError, match="at most 12 months"):
        module.query_trade("customs", "both", "202401", "202501", partner="US")


def test_census_query_maps_import_fields_to_rows(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return [
            ["I_COMMODITY", "I_COMMODITY_LDESC", "CTY_CODE", "GEN_VAL_MO"],
            ["7208", "FLAT-ROLLED IRON", "5800", "12345"],
        ]

    monkeypatch.setenv("CENSUS_API_KEY", "test-census-key")
    monkeypatch.setattr(module, "request_json", fake_request_json)

    result_text = module.query_trade(
        "census",
        "imports",
        "2025-01",
        product="7208",
        partner="5800",
    )
    result = json.loads(result_text)

    assert result["data"][0]["GEN_VAL_MO"] == "12345"
    assert calls[0]["url"].endswith("/imports/hs")
    assert calls[0]["params"]["I_COMMODITY"] == "7208"
    assert "test-census-key" not in result_text


def test_wto_query_sends_subscription_key_in_header(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"Dataset": [{"IndicatorCode": "ITS_MTV_AX", "Value": 1}]}

    monkeypatch.setenv("WTO_API_KEY", "test-wto-key")
    monkeypatch.setattr(module, "request_json", fake_request_json)

    result_text = module.query_trade(
        "wto",
        "exports",
        "2024",
        reporter="KOR",
        indicator="ITS_MTV_AX",
    )

    assert calls[0]["headers"]["Ocp-Apim-Subscription-Key"] == "test-wto-key"
    assert calls[0]["params"]["i"] == "ITS_MTV_AX"
    assert "test-wto-key" not in result_text


def test_eurostat_query_is_strictly_filtered(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {
            "id": ["freq", "reporter", "partner", "product", "flow", "indicators", "time"],
            "value": {"0": 10},
        }

    monkeypatch.setattr(module, "request_json", fake_request_json)

    result = json.loads(
        module.query_trade(
            "comext",
            "imports",
            "2025-01",
            "2025-02",
            product="7208",
            reporter="DE",
            partner="US",
            indicator="VALUE_IN_EUROS",
        )
    )

    params = calls[0]["params"]
    assert params["reporter"] == "DE"
    assert params["partner"] == "US"
    assert params["product"] == "7208"
    assert params["sinceTimePeriod"] == "2025-01"
    assert result["source_id"] == "DS-045409"


def test_health_reports_missing_credentials_without_calling_network(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("CENSUS_API_KEY", raising=False)

    health = json.loads(module.get_source_health("census"))

    assert health["ok"] is False
    assert health["credential"]["configured"] is False
    assert health["credential"]["environment_names"] == ["CENSUS_API_KEY"]


def test_trade_market_config_is_loaded_without_embedded_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"

    configs = load_mcp_configs_from_dirs([mcp_dir])

    config = configs["trade-market"]
    assert isinstance(config, McpStdioServerConfig)
    assert config.args == ["runtime/server.py"]
    assert config.env is None


def test_census_queries_every_month_in_requested_range(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("CENSUS_API_KEY", "test-census-key")
    periods: list[str] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        periods.append(kwargs["params"]["time"])
        return [["CTY_CODE", "GEN_VAL_MO"], ["5800", "10"]]

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(
        module.query_trade(
            "census",
            "imports",
            "2025-01",
            "2025-03",
            product="7208",
            partner="5800",
            limit=10,
        )
    )

    assert periods == ["2025-01", "2025-02", "2025-03"]
    assert [row["time"] for row in result["data"]] == periods


def test_census_requires_partner_to_avoid_unbounded_download(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("CENSUS_API_KEY", "test-census-key")

    with pytest.raises(ValueError, match="partner"):
        module.query_trade("census", "imports", "2025-01", product="7208")


def test_eurostat_rejects_unknown_flow_instead_of_silently_exporting() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="imports or exports"):
        module.query_trade(
            "comext",
            "sideways",
            "2025-01",
            "2025-01",
            product="7208",
            reporter="DE",
            partner="US",
        )


def test_trade_health_converts_probe_failure_to_health_json(monkeypatch) -> None:
    module = _load_server()

    def fail(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(module, "query_trade", fail)
    result = json.loads(module.get_source_health("eurostat_comext"))

    assert result["ok"] is False
    assert "RuntimeError" in result["detail"]


def test_trade_catalogs_cover_all_sources(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("CENSUS_API_KEY", "configured")
    monkeypatch.setenv("WTO_API_KEY", "configured")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        if "variables.json" in url:
            return {
                "variables": {
                    "I_COMMODITY": {"label": "Import commodity", "concept": "Trade"},
                    "CTY_CODE": {"label": "Country", "concept": "Geography"},
                }
            }
        return [
            {"IndicatorCode": "ITS_STEEL", "IndicatorName": "Steel trade"},
            {"IndicatorCode": "ITS_FOOD", "IndicatorName": "Food trade"},
        ]

    monkeypatch.setattr(module, "request_json", fake_json)

    customs = json.loads(module.search_catalog("customs"))
    census = json.loads(module.search_catalog("census", "commodity"))
    wto = json.loads(module.search_catalog("wto", "steel"))
    comext = json.loads(module.search_catalog("comext"))

    assert customs["source_id"] == "15100475"
    assert [row["name"] for row in census["data"]] == ["I_COMMODITY"]
    assert [row["IndicatorCode"] for row in wto["data"]] == ["ITS_STEEL"]
    assert comext["data"]["dataset"] == "DS-045409"


def test_census_exports_and_total_product(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("CENSUS_API_KEY", "configured")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"url": url, **kwargs})
        return [["CTY_CODE", "ALL_VAL_MO"], ["5800", "10"]]

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(
        module.query_trade(
            "census", "exports", "2025-12", "2026-01", product="TOTAL", partner="5800"
        )
    )

    assert all(call["url"].endswith("/exports/hs") for call in calls)
    assert all("E_COMMODITY" not in call["params"] for call in calls)
    assert [row["time"] for row in result["data"]] == ["2025-12", "2026-01"]


def test_customs_xml_and_census_shape_fail_closed() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="invalid XML"):
        module._xml_rows(b"not xml")
    with pytest.raises(ValueError, match="API error 99"):
        module._xml_rows(
            b"<response><header><resultCode>99</resultCode><resultMsg>denied</resultMsg></header></response>"
        )
    with pytest.raises(ValueError, match="unexpected response shape"):
        module._rows_from_census({"error": "bad"}, 10)
    with pytest.raises(DefusedXmlException):
        module._xml_rows(
            b'<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><response>&xxe;</response>'
        )


def test_wto_requires_indicator_and_eurostat_validates_bounds(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("WTO_API_KEY", "configured")

    with pytest.raises(ValueError, match="indicator is required"):
        module.query_trade("wto", "imports", "2025", reporter="KOR")
    with pytest.raises(ValueError, match="frequency"):
        module.query_trade(
            "comext", "imports", "2025-01", reporter="DE", partner="US", frequency="Q"
        )
    with pytest.raises(ValueError, match="at most 10 years"):
        module.query_trade(
            "comext", "imports", "2010", "2020", reporter="DE", partner="US", frequency="A"
        )


@pytest.mark.parametrize("source", ["customs_kr", "census", "wto", "eurostat_comext"])
def test_trade_health_success_for_every_source(monkeypatch, source) -> None:
    module = _load_server()
    monkeypatch.setenv("KCS_TRADE_API_KEY", "configured")
    monkeypatch.setenv("CENSUS_API_KEY", "configured")
    monkeypatch.setenv("WTO_API_KEY", "configured")
    monkeypatch.setattr(module, "query_trade", lambda *_args, **_kwargs: "{}")
    monkeypatch.setattr(module, "request_json", lambda *_args, **_kwargs: {})

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is True


def test_trade_market_skill_requires_bounded_real_data_validation() -> None:
    skill_path = (
        Path(__file__).resolve().parents[2]
        / ".skills/mcp/trade-market/skills/trade-market/SKILL.md"
    )
    text = skill_path.read_text(encoding="utf-8")

    for field in ("reporter", "partner", "product", "period"):
        assert field in text
    assert "search_catalog" in text and "get_source_health" in text
    assert "한 번만 대조" in text
    assert "원 조건은 그대로 0건" in text
    assert "자격증명 차단" in text
    assert "latest_common_annual_trade_data" in text
