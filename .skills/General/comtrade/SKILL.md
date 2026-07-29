---
name: comtrade
description: UN Comtrade 국가별 수출입·품목·교역 상대국 데이터를 조회하는 MCP 라우팅입니다.
source: skill-mcp:comtrade
---

# UN Comtrade MCP

`comtrade` MCP로 국제 상품무역 데이터를 조회합니다.

- 국가 코드를 모르면 `search_reporters`로 먼저 찾습니다.
- API 키가 없어도 되는 소량 확인은 `preview_trade_data`, 정식 조회는 `get_trade_data`를 사용합니다.
- 전체 교역은 `cmd_code="TOTAL"`, 수출은 `flow_code="X"`, 수입은 `flow_code="M"`을 기준으로 사용하되 사용자 조건을 우선합니다.
- 연결 오류가 의심되면 `check_connection`을 호출합니다.
- 답변에 reporter, period, 품목·flow·partner 조건과 UN Comtrade 출처를 함께 밝힙니다.
