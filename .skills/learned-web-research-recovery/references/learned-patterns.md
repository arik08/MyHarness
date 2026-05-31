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

## Evidence bd12408a47de3d3a
- Confidence: 0.85
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=site:news.naver.com 포스코 최근 일주일: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://biz.chosun.com/stock/market_trend/2026/05/22/TFUYSQMUSNDJ7GR4NCFHQ6OUL4/
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 8e3c9005d5668523
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=POSCO Holdings May 2026 news safety organization executive appointment: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://biz.chosun.com/industry/company/2026/05/28/MWRX4SQVF5BDLGDCEUWNVZAFZQ/
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 8c49424797e012ab
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=POSCO news last week May 2026: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Ran web search for 포스코DX 1분기 영업익 급감 AI 로봇 투자 기사
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 919174469367d152
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=site:news.naver.com 포스코 2026.05.30: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://newsroom.posco.com/kr/
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence d3f4299e8e617712
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=POSCO 2026-05-30 news Korea: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://newsroom.posco.com/kr/
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 3c983308c60f3988
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=site:news.google.com 포스코 2026 5 30: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://www.ferrotimes.com/news/articleView.html?idxno=48266
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
