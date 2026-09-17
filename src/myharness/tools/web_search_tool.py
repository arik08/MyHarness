"""Simple web search tool."""

from __future__ import annotations

import html
import re
import time
from html.parser import HTMLParser
from urllib.parse import parse_qs, urlparse

import httpx
from pydantic import BaseModel, Field

from myharness.tools.base import BaseTool, ToolExecutionContext, ToolResult
from myharness.utils.network_guard import NetworkGuardError, fetch_public_http_response


REQUEST_TIMEOUT_SECONDS = 45.0
SEARCH_ENDPOINTS = ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/")


class WebSearchToolInput(BaseModel):
    """Arguments for a web search."""

    query: str = Field(description="Search query. Month names are keywords, not a date-range filter. Prefer focused queries and verify publication dates in results.")
    progress_message: str | None = Field(
        default=None,
        description="도구명 옆에 표시할 짧은 한국어 존댓말 안내. 어떤 자료를 왜 검색하는지 한 문장으로 작성하세요. 아직 확인하지 않은 결과는 말하지 마세요. 검색어가 영어여도 이 안내는 한국어로 작성하세요.",
    )
    max_results: int = Field(default=5, ge=1, le=10, description="Maximum number of results")
    search_url: str | None = Field(
        default=None,
        description="Optional override for the HTML search endpoint, useful for private search backends or testing.",
    )


class WebSearchTool(BaseTool):
    """Run a web search and return compact top results."""

    name = "web_search"
    description = "Search the web and return compact top results with titles, URLs, and snippets."
    input_model = WebSearchToolInput

    def is_read_only(self, arguments: WebSearchToolInput) -> bool:
        del arguments
        return True

    async def execute(
        self,
        arguments: WebSearchToolInput,
        context: ToolExecutionContext,
    ) -> ToolResult:
        del context
        # An explicit backend must never leak its query to another service.
        endpoints = (arguments.search_url,) if arguments.search_url else SEARCH_ENDPOINTS
        deadline = time.monotonic() + REQUEST_TIMEOUT_SECONDS
        attempts: list[dict[str, object]] = []
        results: list[dict[str, str]] = []
        for endpoint in endpoints:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            attempt: dict[str, object] = {"endpoint": endpoint}
            attempts.append(attempt)
            try:
                response = await fetch_public_http_response(
                    endpoint,
                    params={"q": arguments.query},
                    headers={"User-Agent": "MyHarness/0.1"},
                    timeout=min(remaining, REQUEST_TIMEOUT_SECONDS / len(endpoints)),
                )
                attempt["http_status"] = response.status_code
                response.raise_for_status()
            except NetworkGuardError as exc:
                return ToolResult(output=f"web_search 실패: {exc}", is_error=True)
            except httpx.HTTPError as exc:
                attempt.update(outcome="request_failed", error=str(exc))
                continue

            body = response.text
            if _is_search_challenge(body):
                attempt["outcome"] = "blocked"
                continue
            results = _parse_search_results(body, limit=arguments.max_results)
            attempt["result_count"] = len(results)
            if results:
                attempt["outcome"] = "success"
                break
            if _is_empty_search(body):
                attempt["outcome"] = "empty"
                return ToolResult(output="검색 결과가 없습니다.", metadata={"search_attempts": attempts})
            attempt["outcome"] = "unrecognized_response"

        if not results:
            reasons = "; ".join(str(item.get("error") or item["outcome"]) for item in attempts)
            return ToolResult(
                output=f"web_search 실패: 검색 결과를 가져오지 못했습니다. 결과가 없다는 뜻은 아닙니다. ({reasons})",
                is_error=True,
                metadata={"search_attempts": attempts},
            )

        lines = [f"검색 결과: {arguments.query}"]
        for index, result in enumerate(results, start=1):
            lines.append(f"{index}. {result['title']}")
            lines.append(f"   URL: {result['url']}")
            if result["snippet"]:
                lines.append(f"   {result['snippet']}")
        return ToolResult(output="\n".join(lines), metadata={"search_attempts": attempts})


def _is_search_challenge(body: str) -> bool:
    return bool(re.search(r"challenge-form|anomaly\.js|Unfortunately, bots", body, re.I))


def _is_empty_search(body: str) -> bool:
    return bool(re.search(r"class=[\"'][^\"']*\bno-results\b|<h[12][^>]*>\s*No results", body, re.I))


def _parse_search_results(body: str, *, limit: int) -> list[dict[str, str]]:
    parser = _SearchHTMLParser()
    parser.feed(body)
    parser.close()
    return parser.results[:limit]


class _SearchHTMLParser(HTMLParser):
    """Read HTML and Lite results without counting navigation links."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.results: list[dict[str, str]] = []
        self.capture: tuple[str, str] | None = None
        self.depth = 0
        self.parts: list[str] = []
        self.current: dict[str, str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.capture:
            if tag == self.capture[0]:
                self.depth += 1
            return
        attributes = dict(attrs)
        classes = set((attributes.get("class") or "").split())
        if tag == "a" and classes & {"result__a", "result-link"}:
            self.current = {"title": "", "url": _normalize_result_url(attributes.get("href") or ""), "snippet": ""}
            self.capture = (tag, "title")
        elif classes & {"result__snippet", "result-snippet"} and self.current:
            self.capture = (tag, "snippet")
        if self.capture:
            self.depth = 1
            self.parts = []

    def handle_endtag(self, tag: str) -> None:
        if not self.capture or tag != self.capture[0]:
            return
        self.depth -= 1
        if self.depth:
            return
        field = self.capture[1]
        if self.current is not None:
            self.current[field] = re.sub(r"\s+", " ", "".join(self.parts)).strip()
            if field == "title" and self.current["title"] and self.current["url"]:
                self.results.append(self.current)
        self.capture = None

    def handle_data(self, data: str) -> None:
        if self.capture:
            self.parts.append(data)


def _normalize_result_url(raw_url: str) -> str:
    raw_url = html.unescape(raw_url)
    if raw_url.startswith("//"):
        raw_url = "https:" + raw_url
    elif raw_url.startswith("/l/"):
        raw_url = "https://duckduckgo.com" + raw_url
    parsed = urlparse(raw_url)
    if (parsed.hostname == "duckduckgo.com" or (parsed.hostname or "").endswith(".duckduckgo.com")) and parsed.path.startswith("/l/"):
        target = parse_qs(parsed.query).get("uddg", [""])[0]
        parsed = urlparse(target)
        raw_url = target
    return raw_url if parsed.scheme in {"http", "https"} and parsed.hostname else ""
