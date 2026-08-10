"""Tests for the grouped environment-industry MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from myharness.mcp.config import load_mcp_configs_from_dirs


def _load_server() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / ".mcp" / "environment_industry_server.py"
    spec = importlib.util.spec_from_file_location("environment_industry_server_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_prodcom_requires_bounded_dimensions() -> None:
    module = _load_server()

    try:
        module.query_industry("prodcom", filters_json='{"reporter":"DE"}')
    except ValueError as exc:
        assert "reporter, product, and time" in str(exc)
    else:
        raise AssertionError("unbounded PRODCOM query should be rejected")


def test_prodcom_preserves_json_stat(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"class": "dataset", "updated": "2026-07-28", "value": {"0": 10}}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(
        module.query_industry(
            "prodcom",
            filters_json='{"reporter":"DE","product":"24102100","time":"2024"}',
        )
    )

    assert calls[0]["params"]["product"] == "24102100"
    assert result["data"]["class"] == "dataset"


def test_epa_echo_returns_bounded_facilities(monkeypatch) -> None:
    module = _load_server()

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        return {"Results": {"Version": "v1", "QueryRows": "2", "Facilities": [{"FacName": "A"}, {"FacName": "B"}]}}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(module.search_facilities("NUCOR", "AL", limit=1))

    assert result["data"] == [{"FacName": "A"}]
    assert result["metadata"]["query_rows"] == "2"


def test_usda_ers_key_is_not_returned(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("USDA_ERS_API_KEY", "test-key")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return [{"year": 2024, "estimate": 1}]

    monkeypatch.setattr(module, "request_json", fake_json)
    output = module.query_industry(
        "usda_ers",
        filters_json='{"year":"2024","variable":"igcfi"}',
    )

    assert calls[0]["params"]["api_key"] == "test-key"
    assert "test-key" not in output


def test_config_loads_without_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".mcp"
    config = load_mcp_configs_from_dirs([mcp_dir])["environment-industry"]

    assert config.env is None
    assert config.args == [".mcp/environment_industry_server.py"]


def test_prodcom_rejects_multivalue_filters_before_network() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="single scalar"):
        module.query_industry(
            "prodcom",
            filters_json='{"reporter":["DE","FR"],"product":"24102100","time":"2024"}',
        )


def test_prodcom_rejects_response_above_requested_limit(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: {"class": "dataset", "value": {"0": 1, "1": 2}},
    )

    with pytest.raises(ValueError, match="above limit=1"):
        module.query_industry(
            "prodcom",
            filters_json='{"reporter":"DE","product":"24102100","time":"2024"}',
            limit=1,
        )


def test_epa_query_uses_facility_summary_response_set(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"Results": {"Facilities": []}}

    monkeypatch.setattr(module, "request_json", fake_json)
    module.search_facilities("NUCOR", "AL", limit=7)

    assert calls[0]["params"]["responseset"] == "500"


def test_usda_health_reports_missing_key(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("USDA_ERS_API_KEY", raising=False)
    monkeypatch.delenv("DATA_GOV_API_KEY", raising=False)

    result = json.loads(module.get_source_health("usda_ers"))

    assert result["ok"] is False
    assert result["credential"]["configured"] is False


def test_environment_catalogs_cover_all_sources(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("USDA_ERS_API_KEY", "configured")
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: [{"id": "igcfi"}, {"id": "second"}],
    )

    prodcom = json.loads(module.search_catalog("prodcom", "sold", 5))
    echo = json.loads(module.search_catalog("echo", "compliance", 5))
    usda = json.loads(module.search_catalog("ers", "income", 1))

    assert prodcom["data"][0]["dataset"] == "DS-059358"
    assert echo["data"] == ["CAA/CWA/RCRA/SDWA compliance status"]
    assert usda["data"] == [{"id": "igcfi"}]


def test_filter_json_and_dataset_validation() -> None:
    module = _load_server()

    assert module._json_object({"year": "2024"}, name="filters") == {"year": "2024"}
    with pytest.raises(ValueError, match="valid JSON"):
        module._json_object("{bad", name="filters")
    with pytest.raises(ValueError, match="JSON object"):
        module._json_object("[]", name="filters")
    with pytest.raises(ValueError, match="Unsupported filter names"):
        module._bounded_filters({"unknown": "x"}, allowed={"year"})
    with pytest.raises(ValueError, match="too long"):
        module._bounded_filters({"year": "x" * 101}, allowed={"year"})
    with pytest.raises(ValueError, match="Only the verified"):
        module.query_industry(
            "prodcom",
            dataset="DS-000001",
            filters_json={"reporter": "DE", "product": "1", "time": "2024"},
        )


def test_usda_requires_bounded_filters_and_slices_rows(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("USDA_ERS_API_KEY", "configured")
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: [{"row": 1}, {"row": 2}],
    )

    with pytest.raises(ValueError, match="requires year"):
        module.query_industry("usda_ers", filters_json={"state": "IA"})

    result = json.loads(
        module.query_industry(
            "usda_ers", filters_json={"year": "2024", "report": "income"}, limit=1
        )
    )

    assert result["data"] == [{"row": 1}]


def test_epa_query_validation_and_response_errors(monkeypatch) -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="2 to 100"):
        module.search_facilities("A")

    monkeypatch.setattr(module, "request_json", lambda *_args, **_kwargs: {"Results": []})
    with pytest.raises(ValueError, match="unexpected response shape"):
        module.search_facilities("Steel")

    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: {"Results": {"ErrorMessage": "denied"}},
    )
    with pytest.raises(ValueError, match="rejected"):
        module.search_facilities("Steel")

    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: {"Results": {"Facilities": {"bad": "shape"}}},
    )
    with pytest.raises(ValueError, match="Facilities list"):
        module.search_facilities("Steel")


def test_epa_cannot_be_routed_through_industry_query() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="search_facilities"):
        module.query_industry("epa_echo")


@pytest.mark.parametrize("source", ["eurostat_prodcom", "epa_echo", "usda_ers"])
def test_environment_health_success_for_every_source(monkeypatch, source) -> None:
    module = _load_server()
    monkeypatch.setenv("USDA_ERS_API_KEY", "configured")
    monkeypatch.setattr(module, "request_json", lambda *_args, **_kwargs: {})

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is True
