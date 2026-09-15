---
name: trade-market
description: 한국·미국·EU의 품목/상대국별 수출입·무역수지·관세·시장접근을 분석할 때 관세청·Census·COMEXT·WTO를 조회합니다. 여러 국가의 공통 기간 교역 비교는 comtrade, 관세 법령 원문은 legislation-regulation을 사용합니다.
source: skill-mcp:trade-market
---

# 무역·시장 MCP

HS·CN 품목과 국가별 수출입 조회에는 `trade-market` MCP를 사용합니다.

- 한국을 보고국으로 한 품목·국가별 통관 통계는 `source="customs_kr"`를 사용합니다. 국가코드는 ISO 영문 2자리이고 조회기간은 한 번에 12개월 이내입니다.
- 관세청 GW의 공개 Endpoint는 `https://apis.data.go.kr/1220000/nitemtrade`, 상세 기능은 `/getNitemtradeList`입니다. 인증은 승인된 일반 인증키를 `KCS_TRADE_API_KEY` 또는 `DATA_GO_KR_API_KEY` 환경변수로 주입하며, 키 값 자체를 Skill·코드·문서에 기록하지 않습니다.
- 키는 루트의 비공개 `API_KEY.env`에 저장합니다. URL 인코딩된 `%2F`·`%2B`·`%3D` 형태도 그대로 저장할 수 있으며 런타임이 한 번 디코딩한 뒤 HTTP 파라미터로 인코딩합니다. 키를 수동 URL에 이어 붙이거나 이중 인코딩하지 않습니다.
- 관세청 활용신청 승인 대상은 `nitemtrade/getNitemtradeList`입니다. 이 키가 모든 공공데이터포털 API에 승인되었다고 가정하지 않습니다. 예: `query_trade(source="customs_kr", flow="both", start_period="2025-01", end_period="2025-01", product="72", partner="US", limit=5)`. 원 응답은 수입·수출을 함께 제공하므로 실제 반환 필드로 흐름을 구분합니다.
- 미국 수출입은 `source="census"`를 사용합니다. 미국 Census의 숫자형 `CTY_CODE`와 수입·수출 HS 변수가 서로 다름에 주의합니다.
- Census의 HTTP 204는 유효한 조건에 데이터가 없다는 뜻이며 런타임이 빈 목록으로 반환합니다. 오류로 보고 재시도하거나 다른 품목의 수치를 원래 품목의 값으로 대체하지 않습니다.
- EU 회원국의 상세 CN/HS 교역은 `source="eurostat_comext"`와 `DS-045409`를 사용합니다. 대용량 전체 추출을 하지 말고 reporter·partner·product·period를 모두 제한합니다.
- WTO 지표·관세·시장접근은 `source="wto"`를 사용하고, 먼저 `search_catalog`로 지표 코드를 확인합니다.
- WTO의 reporter·partner는 숫자 3자리 기관 코드(한국 `410`, 미국 `840`)입니다. 기간은 연도·분기·월 형식으로 시작과 끝의 단위를 맞춥니다. 수출입 방향과 빈도는 선택한 indicator가 결정하므로 flow·frequency만 바꿔 같은 지표를 재사용하지 않습니다. product는 지표의 품목분류 코드이며 `TOTAL`은 API 기본 품목 선택을 뜻하므로 전체 합계라고 단정하지 않습니다. 예: `query_trade(source="wto", flow="exports", reporter="410", indicator="ITS_MTV_AX", start_period="2023", end_period="2024", limit=5)`.
- 전 세계 여러 보고국 비교는 기존 `comtrade` MCP의 `latest_common_annual_trade_data`를 우선합니다. 서로 다른 국가의 최신 연도를 섞지 않습니다.
- 모든 교역 조회에서 reporter·partner·product·period를 명시적으로 제한하고, 실제 거래가 가능한 국가·품목·기간 조합인지 확인합니다. 빈 결과가 나오면 곧바로 장애로 판정하지 말고 `search_catalog`와 `get_source_health`를 확인한 다음, 같은 요청 의미 안에서 인접한 유효 기간 또는 실제 거래가 알려진 품목 조합을 한 번만 대조합니다.
- 대조 조회는 원래 요청의 의미를 바꾸거나 원래 조건의 결과인 것처럼 제시하기 위한 것이 아닙니다. 대조에서는 값이 나오고 원 조건은 비어 있으면 원 조건은 그대로 0건으로 보고하고, 검증에 사용한 대조 조건을 분리해 밝힙니다. 데이터를 추정하거나 꾸미지 않습니다.
- 연결, 소스별 자격증명, 실제 빈 데이터는 `get_source_health`로 구분합니다. `customs_kr`, `census`, `wto` 등 특정 source의 키가 없으면 그 source만 자격증명 차단으로 표시하고 다른 source나 MCP 전체의 장애로 확대하지 않습니다.
- 결과에는 보고국, 상대국, 품목분류와 버전, 흐름, 기간, 단위, 출처, 완전성을 명시합니다.

## 트리거 경계

- 수출입·HS코드·CN코드·관세·무역수지·교역상대국·공급망 요청에 사용합니다.
- 거시금융 시계열은 `macro-finance`, 기업 공시는 `company-disclosure`, 에너지 가격은 `eia`로 보냅니다.
