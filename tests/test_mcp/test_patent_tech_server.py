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


def test_semantic_detail_cache_expires_and_is_credential_scoped(monkeypatch):
    module = _load_server()
    now = [100.0]
    calls = []
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "test-one")
    monkeypatch.setattr(module.time, "monotonic", lambda: now[0])
    def fetch(*args, **kwargs):
        calls.append(kwargs)
        return {"paperId": "paper", "title": "Steel"}
    monkeypatch.setattr(module, "request_json", fetch)
    assert module._semantic_record("paper")[1]["cache_hit"] is False
    assert module._semantic_record("paper")[1]["cache_hit"] is True
    assert len(calls) == 1
    now[0] += 61
    assert module._semantic_record("paper")[1]["cache_hit"] is False
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "test-two")
    assert module._semantic_record("paper")[1]["cache_hit"] is False
    assert len(calls) == 3


def test_semantic_detail_errors_are_not_cached(monkeypatch):
    module = _load_server()
    monkeypatch.setenv("SEMANTIC_SCHOLAR_API_KEY", "test")
    calls = []
    def fetch(*args, **kwargs):
        calls.append(1)
        if len(calls) == 1:
            raise ValueError("HTTP 429")
        return {"paperId": "paper"}
    monkeypatch.setattr(module, "request_json", fetch)
    with pytest.raises(ValueError, match="429"):
        module._semantic_record("paper")
    assert module._semantic_record("paper")[1]["cache_hit"] is False
    assert len(calls) == 2


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


def test_config_loads_without_credentials(tmp_path) -> None:
    mcp_dir = Path(__file__).resolve().parents[2] / ".skills" / "mcp"
    # Test optional credentials independently of locally provisioned secrets.
    payload = json.loads((mcp_dir / "patent-tech" / "mcp.json").read_text(encoding="utf-8"))
    payload["mcpServers"]["patent-tech"].pop("env", None)
    (tmp_path / "mcp.json").write_text(json.dumps(payload), encoding="utf-8")
    config = load_mcp_configs_from_dirs([tmp_path])["patent-tech"]

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


def test_semantic_scholar_blocks_all_requests_without_key(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.delenv("SEMANTIC_SCHOLAR_API_KEY", raising=False)

    calls = []
    def public_response(*args, **kwargs):
        calls.append(kwargs)
        return {"data": [{"paperId": "fixture"}]}
    monkeypatch.setattr(module, "request_json", public_response)
    with pytest.raises(ValueError, match="기업용 API KEY 신청이 필요합니다"):
        module.search_records("semantic_scholar", "steel")
    with pytest.raises(ValueError, match="기업용 API KEY 신청이 필요합니다"):
        module.get_record("semantic_scholar", "fixture")

    health = json.loads(module.get_source_health("semantic_scholar"))
    assert health["ok"] is False
    assert health["credential"]["required"] is True
    assert health["credential"]["configured"] is False
    assert calls == []


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


EPO_PUBLICATION_XML = """
<publication-reference>
  <document-id document-id-type="docdb"><country>EP</country><doc-number>7654321</doc-number><kind>A1</kind><date>20230315</date></document-id>
  <document-id document-id-type="epodoc"><doc-number>EP7654321</doc-number><date>20230315</date></document-id>
</publication-reference>
"""
EPO_DOCUMENT_XML = f"""
<exchange-document family-id="9876" country="EP" doc-number="7654321" kind="A1">
 <bibliographic-data>
  {EPO_PUBLICATION_XML}
  <application-reference><document-id document-id-type="docdb"><country>KR</country><doc-number>20210001234</doc-number><date>20210401</date></document-id></application-reference>
  <priority-claims><priority-claim sequence="1"><document-id document-id-type="docdb"><country>JP</country><doc-number>20200000567</doc-number><date>20200401</date></document-id></priority-claim></priority-claims>
  <invention-title lang="en">Hydrogen steel</invention-title><invention-title lang="ko">수소 철강</invention-title>
  <parties><applicants><applicant sequence="1" data-format="original"><applicant-name><name>Example applicant</name></applicant-name></applicant></applicants><inventors><inventor sequence="1"><inventor-name><name>Example inventor</name></inventor-name></inventor></inventors></parties>
  <references-cited><citation><patcit><document-id><country>US</country><doc-number>9999999</doc-number><date>20190101</date></document-id></patcit></citation></references-cited>
 </bibliographic-data>
 <abstract lang="en"><p>Before <b>hydrogen</b> after.</p></abstract>
</exchange-document>
"""
EPO_SEARCH_XML = f'<world-patent-data xmlns="http://www.epo.org/exchange">{EPO_DOCUMENT_XML}</world-patent-data>'.encode()
EPO_FAMILY_XML = f"""<world-patent-data xmlns="http://www.epo.org/exchange" xmlns:ops="http://ops.epo.org">
 <ops:patent-family total-result-count="2">
  <ops:family-member family-id="9876">{EPO_PUBLICATION_XML}<exchange-documents>{EPO_DOCUMENT_XML}</exchange-documents></ops:family-member>
  <ops:family-member family-id="9876">{EPO_PUBLICATION_XML.replace('EP', 'NL')}
    <ops:legal code="EXP" desc="Expired"><ops:L007NL desc="Gazette DATE">2025-01-01</ops:L007NL></ops:legal>
  </ops:family-member>
 </ops:patent-family>
</world-patent-data>""".encode()


def test_epo_search_rejects_unbounded_cql_and_parses_xml(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setattr(
        module,
        "_epo_request",
        lambda *_args, **_kwargs: (
            EPO_SEARCH_XML
        ),
    )

    result = json.loads(module.search_records("epo_ops", "ta=steel", limit=1))

    assert result["data"][0]["record_id"] == "EP7654321"
    with pytest.raises(ValueError, match="publication-date constraints"):
        module.search_records("epo_ops", "ta=steel", start_year=2025)
    with pytest.raises(ValueError, match="newline"):
        module.search_records("epo_ops", "ta=steel\npa=example")


def test_epo_keeps_reference_roles_attributes_languages_and_mixed_text():
    row = _load_server()._epo_rows(EPO_SEARCH_XML, limit=2)[0]
    assert row["record_id"] == "EP7654321"
    assert row["publication"] == {"country": "EP", "number": "7654321", "kind": "A1", "date": "20230315"}
    bib = row["bibliographic-data"]
    assert bib["application-reference"]["document-id"]["date"] == "20210401"
    assert bib["priority-claims"]["priority-claim"]["document-id"]["date"] == "20200401"
    assert bib["references-cited"]["citation"]["patcit"]["document-id"]["doc-number"] == "9999999"
    assert bib["invention-title"] == [{"_attributes": {"lang": "en"}, "_text": "Hydrogen steel"}, {"_attributes": {"lang": "ko"}, "_text": "수소 철강"}]
    assert bib["parties"]["applicants"]["applicant"]["applicant-name"]["name"] == "Example applicant"
    assert bib["parties"]["inventors"]["inventor"]["inventor-name"]["name"] == "Example inventor"
    assert row["abstract"]["p"] == {"_text": "Before", "b": {"_text": "hydrogen", "_tail": "after."}}


def test_epo_family_keeps_legal_only_members_and_member_boundaries():
    module = _load_server()
    rows = module._epo_rows(EPO_FAMILY_XML, limit=10)
    assert [row["record_id"] for row in rows] == ["EP7654321", "NL7654321"]
    assert rows[1]["_attributes"]["family-id"] == "9876"
    assert rows[1]["legal"]["_attributes"] == {"code": "EXP", "desc": "Expired"}
    assert rows[1]["legal"]["L007NL"]["_text"] == "2025-01-01"
    assert len(module._epo_rows(EPO_FAMILY_XML, limit=1)) == 1


def test_epo_rejects_error_metadata_and_missing_identity_but_allows_zero_results():
    module = _load_server()
    assert module._epo_rows(b'<world-patent-data><biblio-search total-result-count="0"/></world-patent-data>', limit=2) == []
    for xml in (b'<fault><message>denied</message></fault>', b'<world-patent-data><error>bad request</error></world-patent-data>', b'<world-patent-data><exchange-document/></world-patent-data>'):
        with pytest.raises(ValueError):
            module._epo_rows(xml, limit=2)
    with pytest.raises(DefusedXmlException):
        module._epo_rows(b'<!DOCTYPE root [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><world-patent-data>&xxe;</world-patent-data>', limit=2)


def test_xml_repeated_values_do_not_create_nested_arrays():
    rows = _load_server()._xml_rows(b'<response><item><name>A</name><name>B</name><name>A</name><name>C</name></item></response>', limit=1)
    assert rows == [{"name": ["A", "B", "C"]}]


@pytest.mark.parametrize("status,code,is_empty", [(404, "SERVER.EntityNotFound", True), (404, "SERVER.Other", False), (403, "SERVER.EntityNotFound", False), (429, "SERVER.EntityNotFound", False)])
def test_epo_empty_search_is_distinct_from_auth_rate_limit_and_detail_errors(monkeypatch, status, code, is_empty):
    import httpx
    module = _load_server()
    response = httpx.Response(status, content=f'<fault><code>{code}</code></fault>'.encode(), request=httpx.Request("GET", "https://ops.epo.org/test"))
    def fail(*args, **kwargs):
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as cause:
            raise RuntimeError("official request failed") from cause
    monkeypatch.setattr(module, "_epo_request", fail)
    if is_empty:
        assert json.loads(module.search_records("epo_ops", "ti=absent"))["data"] == []
    else:
        with pytest.raises(RuntimeError):
            module.search_records("epo_ops", "ti=absent")
    with pytest.raises(RuntimeError):
        module.get_record("epo_ops", "EP999999999")


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


def test_kipris_year_range_uses_application_date_search(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("KIPRIS_API_KEY", "configured")
    calls = []
    def fake_request(source, url, **kwargs):
        calls.append((url, kwargs["params"]))
        return type("Response", (), {"content": b"<response><items/></response>"})()
    monkeypatch.setattr(module, "request", fake_request)
    result = json.loads(module.search_records("kipris", "steel", start_year=2024, end_year=2025))
    assert calls[0][0].endswith("/getAdvancedSearch")
    assert calls[0][1]["applicationDate"] == "20240101~20251231"
    assert "year" not in calls[0][1]
    assert result["data"] == []


def test_kipris_error_header_is_not_a_patent_record():
    module = _load_server()
    with pytest.raises(ValueError, match="API error 10"):
        module._xml_rows(b"<response><header><successYN>N</successYN><resultCode>10</resultCode></header></response>", limit=2)


def test_kipris_and_epo_record_routes(monkeypatch) -> None:
    module = _load_server()
    monkeypatch.setenv("KIPRIS_API_KEY", "configured")

    class Response:
        content = b"<response><item><applicationNumber>1020240001234</applicationNumber></item></response>"

    monkeypatch.setattr(module, "request", lambda *_args, **_kwargs: Response())
    monkeypatch.setattr(
        module,
        "_epo_request",
        lambda path, **_kwargs: EPO_FAMILY_XML,
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
