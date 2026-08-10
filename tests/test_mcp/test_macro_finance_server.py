"""Tests for the grouped macro-finance MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from myharness.mcp.config import load_mcp_configs_from_dirs
from myharness.mcp.types import McpStdioServerConfig


def _load_server() -> ModuleType:
    module_path = Path(__file__).resolve().parents[2] / ".mcp" / "macro_finance_server.py"
    spec = importlib.util.spec_from_file_location("macro_finance_server_under_test", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_fred_observations_use_key_without_returning_it(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"observations": [{"date": "2025-01-01", "value": "4.33"}]}

    monkeypatch.setenv("FRED_API_KEY", "test-fred-key")
    monkeypatch.setattr(module, "request_json", fake_request_json)

    result_text = module.query_series("fred", "DFF", "2025-01-01", "2025-01-02")
    result = json.loads(result_text)

    assert result["data"][0]["value"] == "4.33"
    assert calls[0]["params"]["api_key"] == "test-fred-key"
    assert "test-fred-key" not in result_text


def test_ecb_csv_query_preserves_series_metadata(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = (
            b"KEY,FREQ,CURRENCY,TIME_PERIOD,OBS_VALUE,UNIT\n"
            b"D.USD.EUR.SP00.A,D,USD,2025-01-02,1.03,USD per EUR\n"
        )

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append({"source": source, "url": url, **kwargs})
        return Response()

    monkeypatch.setattr(module, "request", fake_request)

    result = json.loads(
        module.query_series("ecb", "D.USD.EUR.SP00.A", "2025-01-01", "2025-01-05", "EXR")
    )

    assert calls[0]["url"].endswith("/data/EXR/D.USD.EUR.SP00.A")
    assert calls[0]["params"]["format"] == "csvdata"
    assert result["data"][0]["OBS_VALUE"] == "1.03"


def test_bis_requests_sdmx_csv(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = b"FREQ,REF_AREA,UNIT_MEASURE,TIME_PERIOD,OBS_VALUE\nA,DE,628,2024,123.4\n"

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append({"source": source, "url": url, **kwargs})
        return Response()

    monkeypatch.setattr(module, "request", fake_request)

    result = json.loads(module.query_series("bis", "A.DE.", "2024", "2024", "WS_LONG_CPI"))

    assert "/data/dataflow/BIS/WS_LONG_CPI/1.0/A.DE." in calls[0]["url"]
    assert "sdmx.data+csv" in calls[0]["headers"]["Accept"]
    assert result["data"][0]["OBS_VALUE"] == "123.4"


def test_nyfed_uses_structured_sofr_endpoint(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_request_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        return {"refRates": [{"effectiveDate": "2025-01-02", "percentRate": 4.4}]}

    monkeypatch.setattr(module, "request_json", fake_request_json)

    result = json.loads(module.query_series("nyfed", "SOFR", "2025-01-01", "2025-01-03"))

    assert calls[0]["url"].endswith("/rates/secured/sofr/search.json")
    assert result["unit"] == "percent"


def test_oecd_query_is_period_bounded_csv(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = b"REF_AREA,Reference area,TIME_PERIOD,OBS_VALUE,Unit of measure\nKOR,Korea,2024-01,101.2,Index\n"

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append({"source": source, "url": url, **kwargs})
        return Response()

    monkeypatch.setattr(module, "request", fake_request)

    result = json.loads(
        module.query_series(
            "oecd",
            "KOR.M.LI...AA...H",
            "2024-01",
            "2024-02",
            "OECD.SDD.STES,DSD_STES@DF_CLI",
        )
    )

    assert calls[0]["params"]["startPeriod"] == "2024-01"
    assert calls[0]["params"]["format"] == "csvfilewithlabels"
    assert result["data"][0]["REF_AREA"] == "KOR"


def test_estat_filters_are_name_restricted(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_estat_json(path: str, params: dict[str, Any]) -> dict[str, Any]:
        calls.append({"path": path, "params": params})
        return {"GET_STATS_DATA": {"STATISTICAL_DATA": {"DATA_INF": {"VALUE": []}}}}

    monkeypatch.setenv("ESTAT_JP_APP_ID", "test-app-id")
    monkeypatch.setattr(module, "_estat_json", fake_estat_json)

    module.query_series("estat_jp", "0003445227", filters_json='{"cdArea":"00000"}')

    assert calls[0]["params"]["cdArea"] == "00000"


def test_health_reports_missing_fred_key(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("FRED_API_KEY", raising=False)

    result = json.loads(module.get_source_health("fred"))

    assert result["ok"] is False
    assert result["credential"]["environment_names"] == ["FRED_API_KEY"]


def test_macro_finance_config_is_loaded_without_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"

    config = load_mcp_configs_from_dirs([mcp_dir])["macro-finance"]

    assert isinstance(config, McpStdioServerConfig)
    assert config.args == [".mcp/macro_finance_server.py"]
    assert config.env is None


def test_nyfed_rrp_uses_repo_operations_endpoint(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"url": url, **kwargs})
        return {"repo": {"operations": [{"operationType": "Reverse Repo"}]}}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(
        module.query_series("nyfed", "RRP", "2025-01-02", "2025-01-03", limit=1)
    )

    assert calls[0]["url"].endswith("/rp/results/search.json")
    assert calls[0]["params"]["operationTypes"] == "Reverse Repo"
    assert result["data"] == [{"operationType": "Reverse Repo"}]


@pytest.mark.parametrize("source", ["fred", "ecb", "bis", "nyfed", "oecd"])
def test_series_sources_require_bounded_periods(source) -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="start_period and end_period"):
        module.query_series(source, "SOFR" if source == "nyfed" else "SERIES")


def test_macro_health_converts_probe_failure_to_health_json(monkeypatch) -> None:
    module = _load_server()

    def fail(*_args, **_kwargs):
        raise RuntimeError("network down")

    monkeypatch.setattr(module, "query_series", fail)
    result = json.loads(module.get_source_health("ecb"))

    assert result["ok"] is False
    assert "RuntimeError" in result["detail"]


def test_macro_catalogs_cover_remote_and_curated_sources(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("FRED_API_KEY", "configured")
    monkeypatch.setenv("ESTAT_JP_APP_ID", "configured")
    monkeypatch.setattr(module, "_fred_json", lambda *_args, **_kwargs: {"seriess": [{"id": "DFF"}]})
    monkeypatch.setattr(
        module,
        "_estat_json",
        lambda *_args, **_kwargs: {
            "GET_STATS_LIST": {"DATALIST_INF": {"TABLE_INF": [{"@id": "1"}]}}
        },
    )
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: {
            "data": {"dataflows": [{"id": "CPI", "name": "Consumer prices"}]}
        },
    )

    fred = json.loads(module.search_catalog("fred", "funds", 1))
    bis = json.loads(module.search_catalog("bis", "consumer", 1))
    estat = json.loads(module.search_catalog("estat_jp", "industry", 1))
    ecb = json.loads(module.search_catalog("ecb", "exchange", 5))
    nyfed = json.loads(module.search_catalog("nyfed", "repo", 5))
    oecd = json.loads(module.search_catalog("oecd", "leading", 5))

    assert fred["data"] == [{"id": "DFF"}]
    assert bis["data"][0]["id"] == "CPI"
    assert estat["data"][0]["@id"] == "1"
    assert ecb["data"][0]["id"] == "EXR"
    assert nyfed["data"][0]["id"] == "RRP"
    assert "DF_CLI" in oecd["data"][0]["id"]


def test_estat_accepts_object_filters_and_rejects_non_objects(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("ESTAT_JP_APP_ID", "configured")

    def fake_estat(path: str, params: dict[str, Any]) -> dict[str, Any]:
        calls.append(params)
        return {"GET_STATS_DATA": {"STATISTICAL_DATA": {}}}

    monkeypatch.setattr(module, "_estat_json", fake_estat)
    module.query_series("estat_jp", "0001", filters_json={"cdArea": "00000"})

    assert calls[0]["cdArea"] == "00000"
    with pytest.raises(ValueError, match="decode to an object"):
        module.query_series("estat_jp", "0001", filters_json="[]")
    with pytest.raises(ValueError, match="Unsupported e-Stat"):
        module.query_series("estat_jp", "0001", filters_json={"apiKey": "bad"})


def test_macro_rejects_missing_dataset_and_bad_nyfed_series() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="dataset is required for ECB"):
        module.query_series("ecb", "D.USD.EUR.SP00.A", "2025-01-01", "2025-01-02")
    with pytest.raises(ValueError, match="dataset is required for BIS"):
        module.query_series("bis", "A.DE.", "2024", "2024")
    with pytest.raises(ValueError, match="dataset is required for OECD"):
        module.query_series("oecd", "KOR.M.LI", "2024-01", "2024-02")
    with pytest.raises(ValueError, match="NY Fed series must be"):
        module.query_series("nyfed", "UNKNOWN", "2025-01-01", "2025-01-02")


def test_nyfed_rejects_unexpected_response_shape(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: {"refRates": {"not": "a list"}},
    )

    with pytest.raises(ValueError, match="unexpected response shape"):
        module.query_series("nyfed", "SOFR", "2025-01-01", "2025-01-02")


@pytest.mark.parametrize("source", ["fred", "ecb", "bis", "nyfed", "oecd", "estat_jp"])
def test_macro_health_success_for_every_source(monkeypatch, source) -> None:
    module = _load_server()
    monkeypatch.setenv("FRED_API_KEY", "configured")
    monkeypatch.setenv("ESTAT_JP_APP_ID", "configured")
    monkeypatch.setattr(module, "query_series", lambda *_args, **_kwargs: "{}")
    monkeypatch.setattr(module, "search_catalog", lambda *_args, **_kwargs: "{}")

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is True
