---
name: environment-industry
description: EU 제품별 산업생산·판매, 미국 사업장 환경위반·검사·집행, 미국 농가 재무·소득·부채 근거가 필요할 때 PRODCOM·EPA ECHO·USDA ERS를 조회합니다. 한국 산업통계는 kosis, 에너지 가격은 eia를 사용합니다.
source: skill-mcp:environment-industry
---

# 산업·원자재·환경 MCP

## 첫 호출과 오류 대응

사용할 함수의 [입력 계약·실수 예방·실제 호출 예시](references/function-inputs.md)를 먼저 확인합니다. 다른 호스트로 옮길 때 이 references 폴더도 함께 복사합니다.

- 이 설명서와 현재 도구 스키마를 먼저 확인합니다. 이미 확보한 유효 ID는 재사용하고, 없는 ID·코드·필수 조건만 검색·카탈로그에서 확인합니다. 예시의 대상·기간을 사용자 조건 대신 사용하지 않습니다.
- 검색이 실패해 ID를 얻지 못하면 그 ID가 필요한 상세 호출도 보류합니다. 실패한 선행 단계를 건너뛰어 임의 ID를 만들지 않습니다. 선택 인자는 필요할 때만 전달하며 스키마가 허용하지 않는 null·빈 문자열을 채우지 않습니다.
- 정상 응답 뒤에는 매번 health를 호출하지 않습니다. 400/422·스키마 오류는 설명과 실제 카탈로그를 보고 잘못된 인자만 수정합니다. 401/403은 해당 소스의 인증·승인 문제로, unexpected keyword argument는 설치된 런타임 버전 문제로 구분하고 검색어 변경으로 반복하지 않습니다.
- 429·시간 초과·fetch 실패는 검색 결과 없음이 아닙니다. 도구 내부 재시도가 소진된 뒤 즉시 같은 요청을 반복하지 않습니다. 서버의 Retry-After·복구 안내에 따르고, 복구 근거가 없으면 해당 단계의 한계를 보고합니다. 복합 도구는 각 하위 단계의 오류·누락도 확인합니다.

산업생산·농업경영·사업장 환경준수에는 `environment-industry` MCP를 사용합니다.

- EU 제품별 생산·판매·수출입은 `source="eurostat_prodcom"`을 사용합니다. `query_industry`에는 `reporter`, `product`, `time`을 모두 넣어 대용량 전체 조회를 방지합니다.
- 미국 철강·에너지 사업장의 CAA·CWA·RCRA·SDWA 준수, 검사·집행 요약은 `search_facilities`를 사용합니다.
- 미국 농가 재무·소득·부채·생산특화는 `source="usda_ers"`의 ARMS 데이터를 사용합니다. 먼저 `search_catalog`로 변수 ID를 확인한 뒤 연도와 report 또는 variable을 지정합니다.
- USDA 조회 조건은 `filters_json={"year":2023,"variable":"검색에서 받은 id"}` 형식입니다. 필터를 도구의 최상위 파라미터로 전달하지 않습니다. 여러 값은 API가 허용하는 쉼표 구분 문자열로 전달하며 배열은 사용하지 않습니다. `data`는 건수 제한이 적용된 행 목록이며 통계 비공개·결측을 0으로 대체하지 않습니다.
- USDA 결과의 `state`가 객체이면 필터에는 그 객체 전체가 아니라 `state.code` 문자열을 사용합니다. 보고서명은 `reportName`, 변수 코드는 카탈로그의 `abb`를 사용합니다.
- 미국 에너지 생산·소비·재고·가격은 새로 중복 구현하지 않고 기존 `eia` MCP를 사용합니다. 한국 산업·물가·생산은 기존 `kosis`, 한국은행 시계열은 기존 `ecos`를 사용합니다.
- IEA 핵심 통계는 상당수가 구독형이고 공개 `api.iea.org` 경로는 공식 공개 API 계약이 아닙니다. IRENA·JODI·USGS·GEM은 주로 대용량 CSV/XLSX/PDF 또는 개별 다운로드라 이 MCP에서 제외합니다.
- EEA·ECHA는 범용 안정 API가 없고 데이터셋별 다운로드·포털 의존성이 커서 자동 라우팅하지 않습니다.
- 구조화 JSON/JSON-stat만 반환하며 PDF·엑셀·OCR 추출을 하지 않습니다.

## 트리거 경계

- 철강·자동차·기계 생산량, PRODCOM, 농가 재무, 미국 사업장 환경준수·위반·검사 요청에 사용합니다.
- HS 수출입은 `trade-market`, 거시 선행지표는 `macro-finance`, 법령 원문은 `legislation-regulation`으로 보냅니다.
