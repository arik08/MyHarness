---
name: trade-market
description: 한국 관세청, U.S. Census, WTO, Eurostat COMEXT와 기존 UN Comtrade를 이용해 HS·CN 품목, 국가, 기간, 수출입, 관세·시장접근 데이터를 조회하는 MCP 라우팅입니다. 철강·원료·가스의 국가별 교역과 공급망 비교에 사용합니다.
source: skill-mcp:trade-market
---

# 무역·시장 MCP

HS·CN 품목과 국가별 수출입 조회에는 `trade-market` MCP를 사용합니다.

- 한국을 보고국으로 한 품목·국가별 통관 통계는 `source="customs_kr"`를 사용합니다. 국가코드는 ISO 영문 2자리이고 조회기간은 한 번에 12개월 이내입니다.
- 관세청 GW의 공개 Endpoint는 `https://apis.data.go.kr/1220000/nitemtrade`, 상세 기능은 `/getNitemtradeList`입니다. 인증은 승인된 일반 인증키를 `KCS_TRADE_API_KEY` 또는 `DATA_GO_KR_API_KEY` 환경변수로 주입하며, 키 값 자체를 Skill·코드·문서에 기록하지 않습니다.
- 미국 수출입은 `source="census"`를 사용합니다. 미국 Census의 숫자형 `CTY_CODE`와 수입·수출 HS 변수가 서로 다름에 주의합니다.
- EU 회원국의 상세 CN/HS 교역은 `source="eurostat_comext"`와 `DS-045409`를 사용합니다. 대용량 전체 추출을 하지 말고 reporter·partner·product·period를 모두 제한합니다.
- WTO 지표·관세·시장접근은 `source="wto"`를 사용하고, 먼저 `search_catalog`로 지표 코드를 확인합니다.
- 전 세계 여러 보고국 비교는 기존 `comtrade` MCP의 `latest_common_annual_trade_data`를 우선합니다. 서로 다른 국가의 최신 연도를 섞지 않습니다.
- 모든 교역 조회에서 reporter·partner·product·period를 명시적으로 제한하고, 실제 거래가 가능한 국가·품목·기간 조합인지 확인합니다. 빈 결과가 나오면 곧바로 장애로 판정하지 말고 `search_catalog`와 `get_source_health`를 확인한 다음, 같은 요청 의미 안에서 인접한 유효 기간 또는 실제 거래가 알려진 품목 조합을 한 번만 대조합니다.
- 대조 조회는 원래 요청의 의미를 바꾸거나 원래 조건의 결과인 것처럼 제시하기 위한 것이 아닙니다. 대조에서는 값이 나오고 원 조건은 비어 있으면 원 조건은 그대로 0건으로 보고하고, 검증에 사용한 대조 조건을 분리해 밝힙니다. 데이터를 추정하거나 꾸미지 않습니다.
- 연결, 소스별 자격증명, 실제 빈 데이터는 `get_source_health`로 구분합니다. `customs_kr`, `census`, `wto` 등 특정 source의 키가 없으면 그 source만 자격증명 차단으로 표시하고 다른 source나 MCP 전체의 장애로 확대하지 않습니다.
- 결과에는 보고국, 상대국, 품목분류와 버전, 흐름, 기간, 단위, 출처, 완전성을 명시합니다.

## 트리거 경계

- 수출입·HS코드·CN코드·관세·무역수지·교역상대국·공급망 요청에 사용합니다.
- 거시금융 시계열은 `macro-finance`, 기업 공시는 `company-disclosure`, 에너지 가격은 기존 `eia` 또는 `energy-commodities`로 보냅니다.
