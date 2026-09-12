---
name: ecos
description: 한국은행 ECOS의 환율·경제통계 시계열을 조회하는 MCP 라우팅입니다.
source: skill-mcp:ecos
---

# 한국은행 ECOS MCP

`ecos` MCP로 한국은행 경제통계를 조회합니다.

- 환율은 `get_exchange_rate`, 주요 지표는 `get_key_statistics`를 우선 사용합니다.
- 일반 통계는 `list_stat_tables`로 통계표 코드를 찾고 `list_stat_items`로 항목 코드를 확인한 뒤 `get_statistic_data`를 호출합니다.
- 연결이나 API 키 문제가 의심되면 `check_connection`을 사용합니다.
- 인증은 루트의 비공개 `API_KEY.env`의 `ECOS_API_KEY`(대체 이름 `BOK_ECOS_API_KEY`)를 사용합니다. 키 변경 후 서버를 재연결합니다.
- 환율 예: `get_exchange_rate(currency="USD", start_date="20250102", end_date="20250103", limit=10)`. 기본 날짜가 최신 기간이라는 보장은 없으므로 사용자 요청 기간을 반드시 지정합니다. JPY100은 100엔 기준이고 휴일은 관측치가 없을 수 있습니다.
- 결과에는 통계표·항목 코드, 기간, 주기, 단위와 ECOS 출처를 명시합니다.
