---
name: development-finance
description: 아시아 국가의 성장·인구·사회·인프라 여건 비교에 ADB KIDB 공식 지표를 조회합니다. 전 세계 개발·부채 지표는 worldbank로 연결합니다. 개별 개발사업 투자·고객사·환경심사 문서 추출은 지원하지 않습니다.
source: skill-mcp:development-finance
---

# 국제개발금융 MCP

## 첫 호출과 오류 대응

사용할 함수의 [입력 계약·실수 예방·실제 호출 예시](references/function-inputs.md)를 먼저 확인합니다. 다른 호스트로 옮길 때 이 references 폴더도 함께 복사합니다.

- 첫 호출 예: `search_catalog(source="adb", query="National Accounts")` → 반환된 dataflow ID로 `search_catalog(source="adb", dataflow="DF_NA", query="GDP")`. 국가 코드는 `search_catalog(source="adb", catalog_type="economies", query="Korea")`에서 확인합니다. 이 예시의 ID도 실제 검색 결과와 일치할 때만 사용합니다. `query_series`는 확보한 지표·경제권 코드와 시작·종료연도를 함께 지정합니다.

- 이 설명서와 현재 도구 스키마를 먼저 확인합니다. 이미 확보한 유효 ID는 재사용하고, 없는 ID·코드·필수 조건만 검색·카탈로그에서 확인합니다. 예시의 대상·기간을 사용자 조건 대신 사용하지 않습니다.
- 검색이 실패해 ID를 얻지 못하면 그 ID가 필요한 상세 호출도 보류합니다. 실패한 선행 단계를 건너뛰어 임의 ID를 만들지 않습니다. 선택 인자는 필요할 때만 전달하며 스키마가 허용하지 않는 null·빈 문자열을 채우지 않습니다.
- 정상 응답 뒤에는 매번 health를 호출하지 않습니다. 400/422·스키마 오류는 설명과 실제 카탈로그를 보고 잘못된 인자만 수정합니다. 401/403은 해당 소스의 인증·승인 문제로, unexpected keyword argument는 설치된 런타임 버전 문제로 구분하고 검색어 변경으로 반복하지 않습니다.
- 429·시간 초과·fetch 실패는 검색 결과 없음이 아닙니다. 도구 내부 재시도가 소진된 뒤 즉시 같은 요청을 반복하지 않습니다. 서버의 Retry-After·복구 안내에 따르고, 복구 근거가 없으면 해당 단계의 한계를 보고합니다. 복합 도구는 각 하위 단계의 오류·누락도 확인합니다.

국제개발금융기관의 국가·산업·인프라 지표에는 `development-finance` MCP를 사용합니다.

- ADB의 아시아 국가·지역 지표는 `source="adb_kidb"`를 사용합니다. 코드가 없으면 `search_catalog`를 dataflow 없이 호출해 데이터플로 ID를 찾고, `catalog_type="economies"`로 경제권 코드를 확인합니다. 이후 dataflow를 지정해 공식 indicator 코드를 찾고 `query_series`에서 지표·경제권 코드를 최대 20개씩 조회합니다. 지표 이름은 dataflow가 아니라 query에 넣습니다. HTTP 422는 정상 빈 결과로 처리하지 말고 데이터플로 코드를 다시 확인합니다.
- 현재 KIDB v5 데이터플로는 국민계정 `DF_NA`, 인구·사회지표 `DF_PPSI`입니다. 예: `search_catalog(source="adb_kidb", dataflow="DF_NA", query="GDP")`에서 지표를 확인한 뒤 `query_series`에 국가와 시작·종료연도를 지정합니다. 다른 데이터플로는 [공식 API 문서](https://kidb.adb.org/api)의 카탈로그에서 확인합니다.
- World Bank 개발·부채·인프라 지표는 이미 설치된 기존 `worldbank` MCP를 사용합니다. 새 서버에서 중복 호출하지 않습니다.
- ADB KIDB는 분당 20회 제한이 있으므로 데이터플로·국가·기간을 묶어 조회하고 불필요한 반복 호출을 피합니다.
- IFC·MIGA·AIIB·EBRD·IDB 프로젝트 포털은 안정적으로 문서화된 프로젝트 레코드 API가 없고, 상세자료가 HTML/PDF/XLSX와 포털 내부 호출에 의존합니다. 자동화하면 화면 변경·문서 OCR·누락 검증 문제가 커지므로 연결하지 않습니다.
- AfDB Open Data는 통계 포털과 프로젝트 문서가 분리되어 있고 안정된 범용 프로젝트 API 계약을 확인하기 어려워 제외합니다.
- 프로젝트 이름이나 PDF 검색 결과를 구조화된 프로젝트 파이프라인으로 오인하지 않습니다. 필요하면 공식 포털 링크를 사람이 확인하는 별도 조사로 처리합니다.

## 트리거 경계

- 아시아 개발지표, ADB SDMX, 국가별 인프라·에너지·거시 비교에 사용합니다.
- 실제 프로젝트 고객사·투자·E&S 문서 자동 추출 요청은 이 MCP가 지원하지 않는다고 명확히 답합니다.
