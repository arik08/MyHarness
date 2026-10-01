---
name: macro-finance
description: 해외 금리·물가·고용·환율·산업생산·경기선행·신용 지표로 수요와 금융여건을 분석할 때 FRED·ECB·BIS·NY Fed·OECD·일본 e-Stat을 조회합니다. 한국은 ecos/kosis, 기업 재무는 company-disclosure를 사용합니다.
source: skill-mcp:macro-finance
---

# 거시·금융 MCP

## 첫 호출과 오류 대응

사용할 함수의 [입력 계약·실수 예방·실제 호출 예시](references/function-inputs.md)를 먼저 확인합니다. 다른 호스트로 옮길 때 이 references 폴더도 함께 복사합니다.

- FRED `series_id`에는 검색 결과의 ID(예: CPIAUCSL)를 넣고 제목을 넣지 않습니다. 소스별 날짜·필터 형식이 다르므로 다른 소스에서 성공한 인자를 그대로 복사하지 않습니다. `unit` 인수 오류가 나타나면 입력 문제가 아니라 지원 모듈의 버전 불일치이므로 MCP 폴더 전체를 일치하는 버전으로 반영해야 합니다.

- 이 설명서와 현재 도구 스키마를 먼저 확인합니다. 이미 확보한 유효 ID는 재사용하고, 없는 ID·코드·필수 조건만 검색·카탈로그에서 확인합니다. 예시의 대상·기간을 사용자 조건 대신 사용하지 않습니다.
- 검색이 실패해 ID를 얻지 못하면 그 ID가 필요한 상세 호출도 보류합니다. 실패한 선행 단계를 건너뛰어 임의 ID를 만들지 않습니다. 선택 인자는 필요할 때만 전달하며 스키마가 허용하지 않는 null·빈 문자열을 채우지 않습니다.
- 정상 응답 뒤에는 매번 health를 호출하지 않습니다. 400/422·스키마 오류는 설명과 실제 카탈로그를 보고 잘못된 인자만 수정합니다. 401/403은 해당 소스의 인증·승인 문제로, unexpected keyword argument는 설치된 런타임 버전 문제로 구분하고 검색어 변경으로 반복하지 않습니다.
- 429·시간 초과·fetch 실패는 검색 결과 없음이 아닙니다. 도구 내부 재시도가 소진된 뒤 즉시 같은 요청을 반복하지 않습니다. 서버의 Retry-After·복구 안내에 따르고, 복구 근거가 없으면 해당 단계의 한계를 보고합니다. 복합 도구는 각 하위 단계의 오류·누락도 확인합니다.

거시경제·금융시장 시계열에는 `macro-finance` MCP를 사용합니다.

- 미국 정책금리·국채금리·CPI·PPI·고용·산업생산은 `source="fred"`를 사용합니다.
- 유로 환율·통화량·은행대출·ECB 지표는 `source="ecb"`, 국제신용·글로벌 유동성·부채 비교는 `source="bis"`를 사용합니다.
- SOFR·TGCR·BGCR·RRP·OBFR는 `source="nyfed"`를 사용합니다.
- 국가 간 선행지수·금융시장·산업지표는 `source="oecd"`, 일본 정부통계는 `source="estat_jp"`를 사용합니다.
- 한국 환율·금리·통화지표는 기존 `ecos`, 국내 통계표는 기존 `kosis` MCP를 우선합니다.
- 먼저 `search_catalog`로 시리즈·데이터셋을 찾고 `query_series`에 공식 ID를 전달합니다. SDMX 소스는 dataset과 차원 순서를 임의로 추측하지 않습니다.
- e-Stat은 검색 결과 `@id`를 `series_id`로 사용합니다. 먼저 소량(`limit=2`) 조회의 `CLASS_INF`에서 지역·시점·분류 코드를 확인한 뒤 `filters_json`의 `cdArea`, `cdCat01`, `cdTime` 또는 `cdTimeFrom`/`cdTimeTo`로 좁힙니다. ISO 날짜인 start_period/end_period를 e-Stat에 전달하지 않습니다. 같은 연도라도 표마다 시점 코드가 다르므로 추측하지 않습니다.
- 연결 확인용 소량 예시: ECB `dataset="EXR", series_id="D.USD.EUR.SP00.A"`; BIS `dataset="WS_LONG_CPI", series_id="A.DE.", start_period="2023", end_period="2024", limit=2`. 이는 환율·독일 CPI 예시이므로 다른 지표를 요청받으면 해당 카탈로그에서 ID를 새로 확인합니다.
- 결과 비교 전 주기, 단위, 계절조정 여부, 기준연도와 개정시점을 확인합니다. ECB만으로 철강 수요를 직접 단정하지 않습니다.
- 인증 또는 연결 문제는 `get_source_health`로 구분합니다.
- FRED는 루트의 비공개 `API_KEY.env`의 `FRED_API_KEY`를 사용하며, 키 변경 후 서버를 재연결합니다. 예: `query_series(source="fred", series_id="DFF", start_period="2025-01-01", end_period="2025-01-03", limit=3)`.
- FRED 관측치의 `value="."`는 결측값입니다. 0으로 바꾸지 말고, 비교 전에 `search_catalog`에서 단위·주기·계절조정 여부를 확인합니다. FRED 키를 ECB·OECD·일본 e-Stat의 인증으로 사용하지 않습니다.

## 트리거 경계

- 금리·물가·환율·통화·고용·산업생산·경기선행·유동성·신용 요청에 사용합니다.
- HS 품목 수출입은 `trade-market`, 기업 재무는 `company-disclosure`, 에너지 현물 가격은 기존 `eia`로 보냅니다.
