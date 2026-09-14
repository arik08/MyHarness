# Historical learning evidence

Preserved for provenance only. Historical confidence and claimed fixes are unverified here. Loading a skill, inspecting an unrelated file, or fetching a different claim is not proof of recovery. Do not replay old commands or paths.

## Original skill: learned-web-research-recovery

## Evidence 18052136ad070f98
- Confidence: 0.85
- Signature: `web-fetch-401-reuters-com`
- Lesson: A repeated failure was observed and later verified as resolved: web_fetch input=https://www.reuters.com/world/asia-pacific/south-koreas-hyundai-steel-says-plans-29-bln-capital-increase-us-steel-plant-2026-01-26/: web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://www.re
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://en.sedaily.com/news/2026/03/17/korean-steelmakers-trapped-in-losses-as-shutdowns-spread
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 06928534ca47a385
- Confidence: 0.95
- Signature: `web-fetch-401-reuters-com`
- Lesson: A repeated failure was observed and later verified as resolved: web_fetch input=https://www.reuters.com/world/asia-pacific/nippon-steel-sees-better-year-ahead-us-steel-no-capacity-cuts-needed-cfo-says-2026-02-19/: web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://www.r
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://www.tatasteel.com/media/25699/4qfy26-and-fy2026-results-presentation.pdf
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 5970ae50b151a21f
- Confidence: 0.85
- Signature: `web-fetch-401-reuters-com`
- Lesson: A repeated failure was observed and later verified as resolved: web_fetch input=https://www.reuters.com/world/asia-pacific/china-releases-tougher-steel-capacity-swap-plan-curb-overcapacity-2026-05-18/: web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://www.reuters.com/w
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://www.tatasteelnederland.com/nieuws/en/tata-steel-nederland-publishes-annual-report-20252026
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence fbb649461d43c734
- Confidence: 0.85
- Signature: `web-fetch-401-reuters-com`
- Lesson: A repeated failure was observed and later verified as resolved: web_fetch input=https://www.reuters.com/world/asia-pacific/chinas-baowu-takes-control-simandou-iron-ore-operator-2026-01-30/: web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://www.reuters.com/world/asia-pa
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://live.euronext.com/en/products/equities/company-news/2026-04-30-arcelormittal-sa-arcelormittal-reports-first-quarter-2026
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence a0078aacf0fbe5a7
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=site:modernatx.com news Moderna 2026 June July: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Ran web search for Moderna FDA advisory committee mRNA-1010 June 18 2026
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 7362a08148f53f2a
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=ABBV AMGN VRTX MRNA stock price performance 2025 2026 Yahoo Finance: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://stockanalysis.com/stocks/vrtx/
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 293ceef713fc1bfb
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=Moderna latest news Reuters June 2025 investor: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://www.newswire.com/view/content/moderna-reports-first-quarter-2026-financial-results-and-provides-business
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence eb0bf27864b6b75c
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input="Moderna Science Day" "INT" "2026": 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://www.modernatx.com/science-day
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.


## Original skill: learned-web-search-no-results

## Evidence 8489d3ffcd115766
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=site:poscohrd.com "DX 교육" "뉴칼라": 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Ran command python -c "from pathlib import Path; p=Path('outputs/포스코인재창조원_DX교육그룹_업무분석.html'); print([repr(x) for x in p.read_text(encoding='utf-8').splitlines() if '런투' in [['\'&quot;포스코그룹 뉴스룸 런투게더 3편&quot;">10</a></sup></p></div></div>\'',
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 666e317c97b47d31
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=포스코 2026 5월 철강 불황 리튬 주가 기사: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Ran command python -c "from pathlib import Path; s=Path('outputs/포스코_국내외_언론동향_최근3개월.html').read_text(encoding='utf-8'); print('footnote_marker', '<!-- myharness:source-foot [footnote_marker False has_tooltip_css True]
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence 64024d760c2f9ddd
- Confidence: 0.95
- Signature: `web-fetch-401-reuters-com`
- Lesson: A repeated failure was observed and later verified as resolved: web_fetch input=https://www.reuters.com/world/asia-pacific/nippon-steel-raises-fy2026-profit-forecast-strong-us-steel-earnings-2026-08-04/: web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://www.reuters.com
- Do next time: Start by applying the verified corrective path: Ran command python -c "from pathlib import Path; from html.parser import HTMLParser; p=Path(r'outputs/포스코_글로벌_경쟁사_2026_이슈_분석.html'); s=p.read_text(encoding='utf-8'); h=HTML [{'chars': 34770, 'source_refs': 15, 'sections': 11, 'closed': True
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence fa72a10d5bb9dbc0
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input="Intel AI-enabled enterprise transformation" Google Cloud July 2026: 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://jp.newsroom.ibm.com/2026-07-06-mufg-bank-mitsubishi-ufj-information-technology-red-hat-and-ibm-japan-enter-into-a-strategic-partnership-for-financial-system-transformation-through-ai-driven-development
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence bb2ffbb64b9cd7cb
- Confidence: low
- Signature: `web-search-no-results`
- Lesson: A later local HTML validation command does not establish that a failed web search was fixed.
- Do next time: Check the search query and source availability, broaden the query, and verify actual retrieved evidence. Resolve any separate visual validator through the installed skill, not a saved machine path.
- Avoid next time: Do not treat unrelated local commands as verified search recovery.

## Evidence ddaee9582e9e69ac
- Confidence: 0.95
- Signature: `web-fetch-401-reuters-com`
- Lesson: A repeated failure was observed and later verified as resolved: web_fetch input=https://www.reuters.com/business/arcelormittal-posts-earnings-beat-european-safeguards-bear-fruit-2026-07-30/: web_fetch 실패: Client error '401 HTTP Forbidden' for url 'https://www.reuters.com/business/arc
- Do next time: Start by applying the verified corrective path: Ran command python -c "from pathlib import Path; p=Path('outputs/포스코_해외경쟁사_2026_이슈분석.html'); s=p.read_text(encoding='utf-8'); print(len(s), s.count('<sup class=\"source-ref [20638 12 True]
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.

## Evidence ad9e741f71efe047
- Confidence: 0.95
- Signature: `web-search-no-results`
- Lesson: A repeated failure was observed and later verified as resolved: web_search input=site:waitbutwhy.com/2015/01/artificial-intelligence-revolution-2.html "paperclip" "AI": 검색 결과가 없습니다.
- Do next time: Start by applying the verified corrective path: Fetched remote content from https://waitbutwhy.com/2015/01/artificial-intelligence-revolution-2.html
- Avoid next time: Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
