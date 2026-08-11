"""Tests for the grouped patent-tech MCP server."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest
from defusedxml.common import DefusedXmlException

from myharness.mcp.config import load_mcp_configs_from_dirs


def _load_server() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / ".skills" / "mcp" / "patent-tech" / "runtime" / "server.py"
    spec = importlib.util.spec_from_file_location("patent_tech_server_under_test", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_kipris_search_uses_key_without_returning_it(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []

    class Response:
        content = b"<response><body><items><item><applicationNumber>1020240001234</applicationNumber><inventionTitle>Hydrogen steel</inventionTitle></item></items></body></response>"

    def fake_request(source: str, url: str, **kwargs: Any) -> Response:
        calls.append(kwargs)
        return Response()

    monkeypatch.setenv("KIPRIS_API_KEY", "test-secret-key")
    monkeypatch.setattr(module, "request", fake_request)
    output = module.search_records("kipris", "수소", 5)
    result = json.loads(output)

    assert calls[0]["params"]["ServiceKey"] == "test-secret-key"
    assert result["data"][0]["applicationNumber"] == "1020240001234"
    assert "test-secret-key" not in output


def test_epo_oauth_token_is_cached(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("EPO_OPS_CLIENT_ID", "client")
    monkeypatch.setenv("EPO_OPS_CLIENT_SECRET", "secret")
    calls: list[dict[str, Any]] = []

    def fake_post(*args: Any, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"access_token": "token", "expires_in": 1200}

    monkeypatch.setattr(module, "post_form_json", fake_post)
    assert module._epo_token() == "token"
    assert module._epo_token() == "token"
    assert len(calls) == 1
    assert calls[0]["auth"] == ("client", "secret")


def test_openalex_search_is_year_bounded(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("OPENALEX_API_KEY", "test-openalex-key")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"results": [{"id": "W1", "title": "Hydrogen steel"}]}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(module.search_records("openalex", "hydrogen steel", 5, 2024, 2025))

    assert "from_publication_date:2024-01-01" in calls[0]["params"]["filter"]
    assert calls[0]["params"]["api_key"] == "test-openalex-key"
    assert result["data"][0]["id"] == "W1"


def test_crossref_doi_is_validated(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module, "request_json", lambda *args, **kwargs: {"message": {"DOI": "10.1000/test"}}
    )

    result = json.loads(module.get_record("crossref", "10.1000/test"))

    assert result["data"]["DOI"] == "10.1000/test"


def test_semantic_scholar_key_is_required_header(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "optional-key")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"data": []}

    monkeypatch.setattr(module, "request_json", fake_json)
    module.search_records("semantic_scholar", "steel")

    assert calls[0]["headers"] == {"x-api-key": "optional-key"}


def test_config_loads_without_credentials() -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"
    config = load_mcp_configs_from_dirs([mcp_dir])["patent-tech"]

    assert config.env is None
    assert config.args == ["runtime/server.py"]


def test_crossref_health_uses_crossref_params_and_returns_json(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("CROSSREF_MAILTO", "maintainer@example.com")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(kwargs)
        return {"status": "ok", "message": {"items": []}}

    monkeypatch.setattr(module, "request_json", fake_json)
    result = json.loads(module.get_source_health("crossref"))

    assert result["ok"] is True
    assert calls[0]["params"]["mailto"] == "maintainer@example.com"


def test_crossref_doi_is_encoded_as_one_path_segment(monkeypatch) -> None:
    module = _load_server()
    urls: list[str] = []

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        urls.append(url)
        return {"message": {"DOI": "10.1000/a/b"}}

    monkeypatch.setattr(module, "request_json", fake_json)
    module.get_record("crossref", "10.1000/a/b")

    assert urls[0].endswith("/10.1000%2Fa%2Fb")


def test_semantic_scholar_requires_key_before_network(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("SEMANTIC_SCHOLAR_API_KEY", raising=False)

    with pytest.raises(ValueError, match="SEMANTIC_SCHOLAR_API_KEY"):
        module.search_records("semantic_scholar", "steel")

    health = json.loads(module.get_source_health("semantic_scholar"))
    assert health["ok"] is False


def test_patent_year_range_is_validated_before_network() -> None:
    module = _load_server()

    with pytest.raises(ValueError, match="end_year"):
        module.search_records("crossref", "steel", start_year=2025, end_year=2024)


def test_openalex_catalog_and_static_catalogs(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("OPENALEX_API_KEY", "configured")
    monkeypatch.setattr(
        module,
        "request_json",
        lambda *_args, **_kwargs: {"results": [{"id": "T1", "display_name": "Steel"}]},
    )

    openalex = json.loads(module.search_catalog("openalex", "steel", 1))
    epo = json.loads(module.search_catalog("epo", "family", 5))

    assert openalex["data"][0]["id"] == "T1"
    assert epo["data"] == ["patent family"]


def test_epo_search_rejects_unbounded_cql_and_parses_xml(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "_epo_request",
        lambda *_args, **_kwargs: (
            b"<world-patent-data><exchange-document><doc-number>EP1</doc-number></exchange-document></world-patent-data>"
        ),
    )

    result = json.loads(module.search_records("epo_ops", "ta=steel", limit=1))

    assert result["data"][0]["doc-number"] == "EP1"
    with pytest.raises(ValueError, match="publication-date constraints"):
        module.search_records("epo_ops", "ta=steel", start_year=2025)
    with pytest.raises(ValueError, match="newline"):
        module.search_records("epo_ops", "ta=steel\npa=example")


def test_crossref_search_and_semantic_scholar_partial_year(monkeypatch) -> None:
    module = _load_server()
    calls: list[dict[str, Any]] = []
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "configured")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append({"source": source, "url": url, **kwargs})
        if source == "Crossref":
            return {"message": {"items": [{"DOI": "10.1000/test"}]}}
        return {"data": [{"paperId": "P1"}]}

    monkeypatch.setattr(module, "request_json", fake_json)

    crossref = json.loads(
        module.search_records("crossref", "steel", start_year=2024, end_year=2025)
    )
    semantic = json.loads(module.search_records("semantic_scholar", "steel", start_year=2025))

    assert crossref["data"][0]["DOI"] == "10.1000/test"
    assert "from-pub-date:2024-01-01" in calls[0]["params"]["filter"]
    assert semantic["data"][0]["paperId"] == "P1"
    assert calls[1]["params"]["year"] == "2025-"


def test_kipris_requires_one_exact_year(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("KIPRIS_API_KEY", "configured")

    with pytest.raises(ValueError, match="one exact year"):
        module.search_records("kipris", "steel", start_year=2024, end_year=2025)


def test_kipris_and_epo_record_routes(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("KIPRIS_API_KEY", "configured")

    class Response:
        content = b"<response><item><applicationNumber>1020240001234</applicationNumber></item></response>"

    monkeypatch.setattr(module, "request", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr(
        module,
        "_epo_request",
        lambda path, **_kwargs: f"<response><item><path>{path}</path></item></response>".encode(),
    )

    kipris = json.loads(module.get_record("kipris", "10-2024-0001234"))
    family = json.loads(module.get_record("epo_ops", "EP1000000", "family"))

    assert kipris["data"][0]["applicationNumber"] == "1020240001234"
    assert family["source_id"].startswith("family/publication")
    with pytest.raises(ValueError, match="record_type"):
        module.get_record("epo_ops", "EP1000000", "claims")


def test_openalex_and_semantic_scholar_record_ids_are_encoded(monkeypatch) -> None:
    module = _load_server()
    calls: list[str] = []
    monkeypatch.setenv("OPENALEX_API_KEY", "configured")
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "configured")

    def fake_json(source: str, url: str, **kwargs: Any) -> object:
        calls.append(url)
        return {"id": "ok"}

    monkeypatch.setattr(module, "request_json", fake_json)

    module.get_record("openalex", "https://openalex.org/W1")
    module.get_record("semantic_scholar", "DOI:10.1000/a/b")

    assert calls[0].endswith("/https%3A%2F%2Fopenalex.org%2FW1")
    assert calls[1].endswith("/DOI%3A10.1000%2Fa%2Fb")


def test_xml_parser_returns_bounded_summary_when_no_items() -> None:
    module = _load_server()

    rows = module._xml_rows(b"<response><status>OK</status><count>1</count></response>", limit=2)

    assert rows == [{"status": "OK", "count": "1"}]


def test_patent_xml_rejects_external_entities() -> None:
    module = _load_server()

    with pytest.raises(DefusedXmlException):
        module._xml_rows(
            b'<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><response>&xxe;</response>',
            limit=1,
        )


@pytest.mark.parametrize(
    "source",
    ["kipris", "epo_ops", "openalex", "crossref", "semantic_scholar"],
)
def test_patent_health_success_for_every_source(monkeypatch, source) -> None:
    module = _load_server()
    monkeypatch.setenv("KIPRIS_API_KEY", "configured")
    monkeypatch.setenv("EPO_OPS_CLIENT_ID", "configured")
    monkeypatch.setenv("EPO_OPS_CLIENT_SECRET", "configured")
    monkeypatch.setenv("OPENALEX_API_KEY", "configured")
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "configured")

    class Response:
        content = b"<response><item><id>1</id></item></response>"

    monkeypatch.setattr(module, "request", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr(module, "request_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(module, "search_records", lambda *_args, **_kwargs: "{}")
    monkeypatch.setattr(module, "_epo_request", lambda *_args, **_kwargs: b"<response/>")

    result = json.loads(module.get_source_health(source))

    assert result["ok"] is True
