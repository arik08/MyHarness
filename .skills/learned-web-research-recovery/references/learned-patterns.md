## Consolidated Evidence

Merged from:
- `learned-category-web-fetch`
- `learned-web-fetch-404-newsroom-posco-com`
- `learned-web-fetch-web-fetch-failed-client-error-400-bad-requ`
- `learned-web-fetch-web-fetch-failed-client-error-403-forbidde`
- `learned-web-fetch-web-fetch-failed-client-error-404-not-foun`
- `learned-web-fetch-web-fetch-실패-client-error-403-forbidden-fo`
- `learned-web-search-검색-결과가-없습니다`
- `learned-web-search-no-results`
- `learned-web-search-no-search-results-found`
- `learned-web-search-web-search-실패-client-error-403-forbidden-`

Reusable patterns:
- Korean no-result searches often recover through bilingual terms, official source pages, RSS, or direct newsroom/investor pages.
- 403s on official pages require alternate official or source-specific routes, not a guess from a saved report.
- Wikipedia, vendor blogs, and corporate/news pages may require Jina Reader, a public API, or a better primary source.
- Raw GitHub 404s should be handled by listing repository contents and branch names first.
- Some generated evidence was low quality because it treated local artifact inspection as web-source recovery; keep that as an anti-pattern, not as a recommended path.
