"""Official patent and research MCP without PDF download or OCR."""

from __future__ import annotations

from typing import Annotated
from pydantic import Field

import json
import httpx
import re
import time
from defusedxml import ElementTree as ET
from datetime import UTC, datetime
from functools import partial
from collections import OrderedDict
from typing import Any
from urllib.parse import quote

from mcp.server.fastmcp import FastMCP
from myharness.mcp.skill_resources import attach_packaged_skill

from myharness.mcp.official_data import (
    checked_health_envelope,
    clean_limit,
    first_env,
    post_form_json,
    request,
    request_json,
    result_envelope,
    safe_identifier,
)


KIPRIS_BASE_URL = "https://plus.kipris.or.kr/kipo-api/kipi/patUtiModInfoSearchSevice"
EPO_AUTH_URL = "https://ops.epo.org/3.2/auth/accesstoken"
EPO_BASE_URL = "https://ops.epo.org/3.2/rest-services"
OPENALEX_BASE_URL = "https://api.openalex.org"
CROSSREF_BASE_URL = "https://api.crossref.org"
SEMANTIC_SCHOLAR_BASE_URL = "https://api.semanticscholar.org/graph/v1"

SOURCES = {
    "kipris": "KIPRISPlus Patent and Utility Model API",
    "epo_ops": "European Patent Office Open Patent Services",
    "openalex": "OpenAlex",
    "crossref": "Crossref REST API",
    "semantic_scholar": "Semantic Scholar Academic Graph API",
}

Source = Annotated[str, Field(description="Source served by patent-tech only", json_schema_extra={"enum": list(SOURCES)})]


server = FastMCP("patent-tech")
attach_packaged_skill(server, __file__)
_EPO_TOKEN: tuple[str, float] | None = None
_SEMANTIC_RECORDS: OrderedDict[tuple[str, str], tuple[float, object]] = OrderedDict()


def _source(source: str) -> str:
    key = source.strip().lower().replace("-", "_")
    aliases = {"kiprisplus": "kipris", "epo": "epo_ops", "s2": "semantic_scholar"}
    key = aliases.get(key, key)
    if key not in SOURCES:
        raise ValueError(f"Unknown source {source!r}. Use one of: {', '.join(SOURCES)}")
    return key


def _required_env(message: str, *names: str) -> str:
    value = first_env(*names)
    if not value:
        raise ValueError(message)
    return value


def _kipris_key() -> str:
    return _required_env(
        "KIPRIS_API_KEY or KIPRIS_PLUS_API_KEY is required for KIPRISPlus.",
        "KIPRIS_API_KEY",
        "KIPRIS_PLUS_API_KEY",
    )


def _xml_local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1].rsplit(":", 1)[-1]


def _xml_rows(content: bytes, *, limit: int) -> list[dict[str, Any]]:
    root = ET.fromstring(content)
    status_fields = {_xml_local_name(e.tag): (e.text or "").strip() for e in root.iter()
                     if _xml_local_name(e.tag) in {"successYN", "resultCode"}}
    if status_fields.get("successYN") == "N":
        raise ValueError(f"KIPRISPlus API error {status_fields.get('resultCode', 'unknown')}; check request parameters and product authorization.")
    rows: list[dict[str, Any]] = []
    for element in root.iter():
        if _xml_local_name(element.tag).lower() not in {"item", "exchange-document"}:
            continue
        row: dict[str, Any] = {}
        for child in element.iter():
            text = (child.text or "").strip()
            if text and len(text) <= 2000:
                key = _xml_local_name(child.tag)
                current = row.get(key)
                if current is None:
                    row[key] = text
                elif isinstance(current, list):
                    if text not in current:
                        current.append(text)
                elif current != text:
                    row[key] = [current, text]
        if row:
            rows.append(row)
        if len(rows) >= limit:
            break
    if rows:
        return rows
    if status_fields or any(_xml_local_name(e.tag) == "items" for e in root.iter()):
        return []
    summary: dict[str, Any] = {}
    for element in root.iter():
        text = (element.text or "").strip()
        if text and len(text) <= 2000:
            summary.setdefault(_xml_local_name(element.tag), text)
        if len(summary) >= 250:
            break
    return [summary] if summary else []


def _xml_object(element: Any) -> object:
    """Preserve XML ancestry, attributes and repeated siblings without flattening."""
    result: dict[str, Any] = {}
    if element.attrib:
        result["_attributes"] = dict(element.attrib)
    text = (element.text or "").strip()
    if text:
        result["_text"] = text
    tail = (element.tail or "").strip()
    if tail:
        result["_tail"] = tail
    groups: dict[str, list[object]] = {}
    for child in element:
        groups.setdefault(_xml_local_name(child.tag), []).append(_xml_object(child))
    for name, values in groups.items():
        result[name] = values[0] if len(values) == 1 else values
    if set(result) == {"_text"}:
        return result["_text"]
    return result


def _epo_rows(content: bytes, *, limit: int) -> list[dict[str, Any]]:
    root = ET.fromstring(content)
    members = list(root.iterfind(".//{*}family-member"))
    documents = members or list(root.iterfind(".//{*}exchange-document"))
    if _xml_local_name(root.tag) in {"family-member", "exchange-document"}:
        documents = [root]
    if not documents:
        search = root.find(".//{*}biblio-search")
        if search is not None and search.get("total-result-count") == "0":
            return []
        raise ValueError("EPO OPS returned XML without patent records or an explicit empty search result.")
    rows = []
    for document in documents[:limit]:
        # Family members may contain legal data only; their own publication
        # reference remains authoritative even when no exchange-document exists.
        reference = document.find("./{*}publication-reference")
        if reference is None:
            reference = document.find("./{*}bibliographic-data/{*}publication-reference")
        if reference is None:
            raise ValueError("EPO OPS record is missing its publication reference.")
        identifiers = {}
        for identifier in reference.findall("./{*}document-id"):
            identifiers[identifier.get("document-id-type", "")] = {
                _xml_local_name(child.tag): (child.text or "").strip()
                for child in identifier
            }
        docdb = identifiers.get("docdb", {})
        epodoc = identifiers.get("epodoc", {})
        record_id = epodoc.get("doc-number") or (
            docdb.get("country", "") + docdb.get("doc-number", "")
        )
        if not record_id:
            raise ValueError("EPO OPS record is missing its publication identifier.")
        row = _xml_object(document)
        row["record_id"] = record_id
        row["publication"] = {
            "country": docdb.get("country", ""),
            "number": docdb.get("doc-number", ""),
            "kind": docdb.get("kind", ""),
            "date": docdb.get("date") or epodoc.get("date", ""),
        }
        rows.append(row)
    return rows


def _epo_token() -> str:
    global _EPO_TOKEN
    now = time.monotonic()
    if _EPO_TOKEN and _EPO_TOKEN[1] > now + 30:
        return _EPO_TOKEN[0]
    client_id = _required_env("EPO_OPS_CLIENT_ID is required for EPO OPS.", "EPO_OPS_CLIENT_ID")
    client_secret = _required_env(
        "EPO_OPS_CLIENT_SECRET is required for EPO OPS.", "EPO_OPS_CLIENT_SECRET"
    )
    payload = post_form_json(
        "EPO OPS",
        EPO_AUTH_URL,
        data={"grant_type": "client_credentials"},
        auth=(client_id, client_secret),
    )
    if not isinstance(payload, dict) or not payload.get("access_token"):
        raise RuntimeError("EPO OPS authentication returned an unexpected response.")
    ttl = max(60, int(payload.get("expires_in", 1200)))
    _EPO_TOKEN = (str(payload["access_token"]), now + ttl)
    return _EPO_TOKEN[0]


def _epo_request(path: str, *, params: dict[str, Any] | None = None) -> bytes:
    response = request(
        "EPO OPS",
        f"{EPO_BASE_URL}/{path.lstrip('/')}",
        params=params,
        headers={"Authorization": f"Bearer {_epo_token()}", "Accept": "application/xml"},
        timeout=60,
    )
    return response.content


def _epo_search(cql: str, limit: int) -> list[dict[str, Any]]:
    try:
        content = _epo_request("published-data/search/biblio", params={"q": cql, "Range": f"1-{limit}"})
    except RuntimeError as exc:
        cause = exc.__cause__
        if isinstance(cause, httpx.HTTPStatusError) and cause.response.status_code == 404:
            try:
                fault = ET.fromstring(cause.response.content)
            except ET.ParseError:
                raise exc
            if (_xml_local_name(fault.tag) == "fault"
                    and fault.findtext("./{*}code") == "SERVER.EntityNotFound"):
                return []
        raise
    return _epo_rows(content, limit=limit)


def _openalex_params() -> dict[str, str]:
    return {
        "api_key": _required_env("OPENALEX_API_KEY is required for OpenAlex.", "OPENALEX_API_KEY")
    }


def _crossref_params() -> dict[str, str]:
    email = first_env("CROSSREF_MAILTO")
    return {"mailto": email} if email else {}


def _semantic_headers() -> dict[str, str]:
    key = _required_env(
        "SEMANTIC_SCHOLAR_API_KEY is required. 기업용 API KEY 신청이 필요합니다.",
        "SEMANTIC_SCHOLAR_API_KEY",
    )
    return {"x-api-key": key}


def _semantic_record(paper_id: str) -> tuple[object, dict[str, Any]]:
    headers = _semantic_headers()
    key = (headers["x-api-key"], paper_id)
    cached = _SEMANTIC_RECORDS.get(key)
    if cached and time.monotonic() - cached[0] < 60:
        _SEMANTIC_RECORDS.move_to_end(key)
        return cached[1], {"cache_hit": True, "cache_age_seconds": round(time.monotonic() - cached[0], 2)}
    payload = request_json(
        "Semantic Scholar", f"{SEMANTIC_SCHOLAR_BASE_URL}/paper/{quote(paper_id, safe='')}",
        params={"fields": "paperId,title,abstract,year,authors,citationCount,referenceCount,externalIds,url"},
        headers=headers, minimum_interval=5.0,
    )
    if isinstance(payload, dict) and payload.get("paperId"):
        _SEMANTIC_RECORDS[key] = (time.monotonic(), payload)
        _SEMANTIC_RECORDS.move_to_end(key)
        while len(_SEMANTIC_RECORDS) > 128:
            _SEMANTIC_RECORDS.popitem(last=False)
    return payload, {"cache_hit": False}


def _year_range(start_year: int | None, end_year: int | None) -> tuple[int | None, int | None]:
    """Validate an optional inclusive publication-year range."""
    current_year = datetime.now(UTC).year
    for field_name, value in (("start_year", start_year), ("end_year", end_year)):
        if value is not None and not 1800 <= int(value) <= current_year + 1:
            raise ValueError(f"{field_name} must be between 1800 and {current_year + 1}.")
    if start_year is not None and end_year is not None and int(end_year) < int(start_year):
        raise ValueError("end_year must not be earlier than start_year.")
    return start_year, end_year


@server.tool()
def search_catalog(source: Source, query: str = "", limit: int = 20) -> str:
    """OpenAlex searches research topics. Other sources return supported operations,
    not papers/patents; use search_records for subject keywords.
    """
    selected = _source(source)
    safe_limit = clean_limit(limit, maximum=100)
    if selected == "openalex":
        payload = request_json(
            "OpenAlex",
            f"{OPENALEX_BASE_URL}/topics",
            params={"search": query, "per-page": safe_limit, **_openalex_params()},
        )
        data: object = payload.get("results", []) if isinstance(payload, dict) else payload
        source_id = "topics"
    else:
        catalog = {
            "kipris": ["keyword search", "application-number bibliography"],
            "epo_ops": ["published-data search", "bibliography", "patent family"],
            "crossref": ["works", "DOI metadata"],
            "semantic_scholar": ["paper search", "paper metadata"],
        }[selected]
        needle = query.casefold().strip()
        data = [item for item in catalog if not needle or needle in item.casefold()][:safe_limit]
        source_id = "supported_record_types"
    return result_envelope(
        source=SOURCES[selected],
        source_id=source_id,
        data=data,
        completeness="bounded_catalog",
        license_name="Official source reuse terms",
    )


@server.tool()
def search_records(
    source: Source,
    query: str,
    limit: int = 20,
    start_year: int | None = None,
    end_year: int | None = None,
) -> str:
    """Search patent bibliographies or papers. KIPRIS year bounds filter application
    dates using advanced search (one bound means that exact year). EPO uses CQL dates
    inside query. OpenAlex/Crossref/Semantic Scholar accept publication year bounds.
    Use returned applicationNumber/record_id/id/paperId/DOI unchanged for get_record.
    EPO publication identifies the returned publication; nested XML fields retain
    separate application, priority, party, language and legal-event contexts.
    """
    selected = _source(source)
    safe_limit = clean_limit(limit, maximum=100)
    if not query.strip():
        raise ValueError("query is required.")
    start_year, end_year = _year_range(start_year, end_year)
    if selected == "kipris":
        dated = start_year is not None or end_year is not None
        operation = "getAdvancedSearch" if dated else "getWordSearch"
        date_params = {"applicationDate": f"{start_year or end_year}0101~{end_year or start_year}1231"} if dated else {"year": 0}
        response = request(
            "KIPRISPlus",
            f"{KIPRIS_BASE_URL}/{operation}",
            params={
                "word": query,
                **date_params,
                "patent": "true",
                "utility": "true",
                "numOfRows": safe_limit,
                "pageNo": 1,
                "ServiceKey": _kipris_key(),
            },
            timeout=60,
        )
        data: object = _xml_rows(response.content, limit=safe_limit)
        source_id = operation
    elif selected == "epo_ops":
        if start_year is not None or end_year is not None:
            raise ValueError("Put publication-date constraints in the EPO OPS CQL query.")
        cql = query.strip()
        if len(cql) > 500 or any(character in cql for character in "\r\n"):
            raise ValueError("EPO OPS CQL query is too long or contains a newline.")
        data = _epo_search(cql, safe_limit)
        source_id = "published-data/search/biblio"
    elif selected == "openalex":
        filters = []
        if start_year:
            filters.append(f"from_publication_date:{int(start_year)}-01-01")
        if end_year:
            filters.append(f"to_publication_date:{int(end_year)}-12-31")
        payload = request_json(
            "OpenAlex",
            f"{OPENALEX_BASE_URL}/works",
            params={
                "search": query,
                "filter": ",".join(filters) or None,
                "per-page": safe_limit,
                **_openalex_params(),
            },
        )
        data = payload.get("results", []) if isinstance(payload, dict) else payload
        source_id = "works"
    elif selected == "crossref":
        filters = []
        if start_year:
            filters.append(f"from-pub-date:{int(start_year)}-01-01")
        if end_year:
            filters.append(f"until-pub-date:{int(end_year)}-12-31")
        payload = request_json(
            "Crossref",
            f"{CROSSREF_BASE_URL}/works",
            params={
                "query": query,
                "rows": safe_limit,
                "filter": ",".join(filters) or None,
                **_crossref_params(),
            },
        )
        message = payload.get("message", {}) if isinstance(payload, dict) else {}
        data = message.get("items", []) if isinstance(message, dict) else []
        source_id = "works"
    else:
        payload = request_json(
            "Semantic Scholar",
            f"{SEMANTIC_SCHOLAR_BASE_URL}/paper/search",
            params={
                "query": query,
                "limit": min(safe_limit, 100),
                "fields": "paperId,title,abstract,year,authors,citationCount,externalIds,url",
                "year": f"{start_year or ''}-{end_year or ''}" if start_year or end_year else None,
            },
            headers=_semantic_headers(),
            minimum_interval=5.0,
        )
        data = payload.get("data", []) if isinstance(payload, dict) else payload
        source_id = "paper/search"
    return result_envelope(
        source=SOURCES[selected],
        source_id=source_id,
        data=data,
        as_of=str(end_year) if end_year else None,
        revision="latest_returned_by_api",
        completeness="query_and_page_limited",
        license_name="Official source reuse terms",
    )


@server.tool()
def get_record(source: Source, record_id: str, record_type: str = "detail") -> str:
    """Get metadata from a search result ID: KIPRIS applicationNumber (not registerNumber),
    OpenAlex id, Semantic Scholar paperId, Crossref DOI. record_type=detail works for all;
    bibliography is patent-only, family is EPO-only. No PDF download or reference-list tool.
    """
    selected = _source(source)
    kind = record_type.strip().lower()
    metadata = None
    if selected == "kipris":
        if kind not in {"detail", "bibliography"}:
            raise ValueError("KIPRISPlus record_type must be detail or bibliography.")
        application_number = safe_identifier(
            record_id.replace("-", ""), field_name="application_number", pattern=r"\d{10,20}"
        )
        response = request(
            "KIPRISPlus",
            f"{KIPRIS_BASE_URL}/getBibliographyDetailInfoSearch",
            params={"applicationNumber": application_number, "ServiceKey": _kipris_key()},
            timeout=60,
        )
        payload: object = _xml_rows(response.content, limit=20)
        source_id = f"application/{application_number}"
    elif selected == "epo_ops":
        patent_id = safe_identifier(
            record_id.replace(" ", ""), field_name="patent_id", pattern=r"[A-Za-z0-9.]{4,30}"
        )
        if kind not in {"detail", "bibliography", "family"}:
            raise ValueError("EPO OPS record_type must be detail, bibliography, or family.")
        if kind == "family":
            path = f"family/publication/epodoc/{patent_id}/biblio,legal"
        else:
            path = f"published-data/publication/epodoc/{patent_id}/biblio"
        payload = _epo_rows(_epo_request(path), limit=100)
        source_id = path
    elif selected == "openalex":
        if kind != "detail":
            raise ValueError("OpenAlex record_type must be detail.")
        identifier = record_id.strip()
        if not identifier or len(identifier) > 300:
            raise ValueError("OpenAlex record_id is invalid.")
        payload = request_json(
            "OpenAlex",
            f"{OPENALEX_BASE_URL}/works/{quote(identifier, safe='')}",
            params=_openalex_params(),
        )
        source_id = identifier
    elif selected == "crossref":
        if kind != "detail":
            raise ValueError("Crossref record_type must be detail.")
        doi = record_id.strip()
        if not re.fullmatch(r"10\.\d{4,9}/\S+", doi, flags=re.IGNORECASE):
            raise ValueError("Crossref record_id must be a DOI.")
        payload_raw = request_json(
            "Crossref",
            f"{CROSSREF_BASE_URL}/works/{quote(doi, safe='')}",
            params=_crossref_params(),
        )
        payload = (
            payload_raw.get("message", payload_raw)
            if isinstance(payload_raw, dict)
            else payload_raw
        )
        source_id = doi
    else:
        if kind != "detail":
            raise ValueError("Semantic Scholar record_type must be detail.")
        paper_id = record_id.strip()
        if (
            not paper_id
            or len(paper_id) > 300
            or any(character in paper_id for character in "\r\n")
        ):
            raise ValueError("Semantic Scholar paper_id is invalid.")
        payload, metadata = _semantic_record(paper_id)
        source_id = paper_id
    return result_envelope(
        source=SOURCES[selected],
        source_id=source_id,
        data=payload,
        revision="latest_returned_by_api",
        completeness="structured_metadata_no_pdf_or_ocr",
        license_name="Official source reuse terms",
        metadata=metadata,
    )


@server.tool()
def get_source_health(source: Source) -> str:
    """Perform a lightweight official endpoint check and safely report credential needs."""
    selected = _source(source)
    if selected == "kipris":
        credential = ("KIPRIS_API_KEY", "KIPRIS_PLUS_API_KEY")
        detail = "KIPRISPlus patent REST API is reachable."
        probe = partial(search_records, "kipris", "수소", 1)
    elif selected == "epo_ops":
        credential = ("EPO_OPS_CLIENT_ID", "EPO_OPS_CLIENT_SECRET")
        detail = "EPO OPS OAuth and published-data API are reachable."
        probe = partial(_epo_request, "published-data/publication/epodoc/EP1000000/biblio")
    elif selected == "openalex":
        credential = ("OPENALEX_API_KEY",)
        detail = "OpenAlex API is reachable with the configured key."

        def probe() -> object:
            return request_json(
                "OpenAlex",
                f"{OPENALEX_BASE_URL}/works",
                params={"per-page": 1, **_openalex_params()},
            )

    elif selected == "crossref":
        credential = ()
        detail = "Crossref REST API is reachable. CROSSREF_MAILTO is recommended."
        probe = partial(
            request_json,
            "Crossref",
            f"{CROSSREF_BASE_URL}/works",
            params={"rows": 1, **_crossref_params()},
        )
    else:
        credential = ("SEMANTIC_SCHOLAR_API_KEY",)
        detail = "Semantic Scholar API is reachable with the configured key."

        def probe() -> object:
            return request_json(
                "Semantic Scholar",
                f"{SEMANTIC_SCHOLAR_BASE_URL}/paper/search",
                params={"query": "steel", "limit": 1, "fields": "paperId,title"},
                headers=_semantic_headers(),
                minimum_interval=5.0,
            )

    return checked_health_envelope(
        source=SOURCES[selected],
        credential_env=credential,
        require_all_credentials=selected == "epo_ops",
        probe=probe,
        success_detail=detail,
    )


@server.resource("patent-tech://overview", name="Patent and technology MCP overview")
def overview() -> str:
    """Describe sources, credentials, and the no-PDF/OCR policy."""
    return json.dumps(
        {
            "sources": SOURCES,
            "credentials": {
                "kipris": ["KIPRIS_API_KEY", "KIPRIS_PLUS_API_KEY"],
                "epo_ops": ["EPO_OPS_CLIENT_ID", "EPO_OPS_CLIENT_SECRET"],
                "openalex": ["OPENALEX_API_KEY"],
                "crossref": ["CROSSREF_MAILTO (recommended)"],
                "semantic_scholar": ["SEMANTIC_SCHOLAR_API_KEY (required in this environment)"],
            },
            "document_policy": "Bibliographic JSON/XML only; no patent PDF/full-text download or OCR.",
        },
        ensure_ascii=False,
        indent=2,
    )


if __name__ == "__main__":
    server.run("stdio")
