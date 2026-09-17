"""Search recovery must return actual candidates without changing the query."""
import httpx
import pytest

from myharness.tools.base import ToolExecutionContext
from myharness.tools import web_search_tool as search

RESULTS = """<a href='/menu'>Menu</a>
<a CLASS='result__a' HREF='//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa%253Fb&amp;rut=x'>A <b>report</b></a>
<a class='result__url' href='https://example.com'>example.com</a>
<div class='result__snippet'>First <b>summary</b></div>
<a class=result__a href=https://example.org/other>Other report</a>
<div class=result__snippet>Second summary</div>"""
LITE = """<table><tr><td><a href='https://example.org/lite' class='result-link'>Lite report</a></td></tr>
<tr><td class='result-snippet'>Lite summary</td></tr></table>"""


def test_parser_handles_html_variants_and_pairs_snippets_with_results():
    results = search._parse_search_results(RESULTS, limit=10)
    assert results == [
        {"title": "A report", "url": "https://example.com/a%3Fb", "snippet": "First summary"},
        {"title": "Other report", "url": "https://example.org/other", "snippet": "Second summary"},
    ]
    assert search._parse_search_results(RESULTS, limit=1) == results[:1]
    assert search._parse_search_results(LITE, limit=10)[0]["snippet"] == "Lite summary"


@pytest.mark.asyncio
@pytest.mark.parametrize("first", [
    (202, '<form id="challenge-form">Unfortunately, bots</form>'),
    (200, "<html>Unexpected response</html>"),
    (503, "Unavailable"),
    "timeout",
])
async def test_recovers_actual_results_from_second_endpoint(tmp_path, monkeypatch, first):
    calls = []

    async def fetch(url, **kwargs):
        calls.append((url, kwargs))
        if len(calls) == 1:
            if first == "timeout":
                raise httpx.ReadTimeout("timeout")
            status, body = first
        else:
            status, body = 200, LITE
        return httpx.Response(status, text=body, request=httpx.Request("GET", url))

    monkeypatch.setattr(search, "fetch_public_http_response", fetch)
    query = "site:reuters.com POSCO 2026 July August September"
    result = await search.WebSearchTool().execute(search.WebSearchToolInput(query=query), ToolExecutionContext(cwd=tmp_path))
    assert not result.is_error
    assert "https://example.org/lite" in result.output
    assert "Lite summary" in result.output
    assert [call[0] for call in calls] == list(search.SEARCH_ENDPOINTS)
    assert all(call[1]["params"] == {"q": query} for call in calls)
    assert len(result.metadata["search_attempts"]) == 2


@pytest.mark.asyncio
@pytest.mark.parametrize("body,expected_calls,is_error", [
    (RESULTS, 1, False),
    ('<div class="no-results"><h1>No results found</h1></div>', 1, False),
    ('<form id="challenge-form">bots</form>', 2, True),
    ("<html>unrecognized</html>", 2, True),
])
async def test_success_empty_and_exhausted_recovery(tmp_path, monkeypatch, body, expected_calls, is_error):
    calls = []

    async def fetch(url, **kwargs):
        calls.append(url)
        return httpx.Response(200, text=body, request=httpx.Request("GET", url))

    monkeypatch.setattr(search, "fetch_public_http_response", fetch)
    result = await search.WebSearchTool().execute(search.WebSearchToolInput(query="arbitrary new query"), ToolExecutionContext(cwd=tmp_path))
    assert len(calls) == expected_calls
    assert result.is_error is is_error
    if is_error:
        assert result.output != "검색 결과가 없습니다."
    elif "no-results" in body:
        assert result.output == "검색 결과가 없습니다."


@pytest.mark.asyncio
async def test_custom_backend_does_not_fall_back_to_public_search(tmp_path, monkeypatch):
    calls = []

    async def fetch(url, **kwargs):
        calls.append(url)
        return httpx.Response(200, text="unknown", request=httpx.Request("GET", url))

    monkeypatch.setattr(search, "fetch_public_http_response", fetch)
    result = await search.WebSearchTool().execute(
        search.WebSearchToolInput(query="private query", search_url="https://search.example.org/"),
        ToolExecutionContext(cwd=tmp_path),
    )
    assert result.is_error
    assert calls == ["https://search.example.org/"]
