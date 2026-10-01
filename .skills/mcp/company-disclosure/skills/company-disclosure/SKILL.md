---
name: company-disclosure
description: 기업 실적·경쟁사 재무·사업·투자·리스크 분석에 공식 공시 근거가 필요할 때 사용합니다. 한국 DART/OpenDART, 미국 SEC EDGAR, 영국 Companies House의 기업 식별·분기/사업보고서·XBRL 재무·제출 이력을 조회합니다.
source: skill-mcp:company-disclosure
---

# 기업공시 MCP

## 첫 호출과 오류 대응

사용할 함수의 [입력 계약·실수 예방·실제 호출 예시](references/function-inputs.md)를 먼저 확인합니다. 다른 호스트로 옮길 때 이 references 폴더도 함께 복사합니다.

- 이 설명서와 현재 도구 스키마를 먼저 확인합니다. 이미 확보한 유효 ID는 재사용하고, 없는 ID·코드·필수 조건만 검색·카탈로그에서 확인합니다. 예시의 대상·기간을 사용자 조건 대신 사용하지 않습니다.
- 검색이 실패해 ID를 얻지 못하면 그 ID가 필요한 상세 호출도 보류합니다. 실패한 선행 단계를 건너뛰어 임의 ID를 만들지 않습니다. 선택 인자는 필요할 때만 전달하며 스키마가 허용하지 않는 null·빈 문자열을 채우지 않습니다.
- 정상 응답 뒤에는 매번 health를 호출하지 않습니다. 400/422·스키마 오류는 설명과 실제 카탈로그를 보고 잘못된 인자만 수정합니다. 401/403은 해당 소스의 인증·승인 문제로, unexpected keyword argument는 설치된 런타임 버전 문제로 구분하고 검색어 변경으로 반복하지 않습니다.
- 429·시간 초과·fetch 실패는 검색 결과 없음이 아닙니다. 도구 내부 재시도가 소진된 뒤 즉시 같은 요청을 반복하지 않습니다. 서버의 Retry-After·복구 안내에 따르고, 복구 근거가 없으면 해당 단계의 한계를 보고합니다. 복합 도구는 각 하위 단계의 오류·누락도 확인합니다.

기업·공시·재무 조회에는 `company-disclosure` MCP를 사용합니다.

- 한국 기업은 `source="opendart"`, 미국 상장사는 `source="sec"`, 영국 법인은 `source="companies_house"`를 사용합니다.
- 회사 코드가 없으면 `search_catalog`로 먼저 찾습니다. 회사명보다 종목코드·CIK·법인번호가 있으면 이를 우선합니다.
- 공시 목록은 `search_records`, 회사 개황이나 구조화 재무는 `get_record`를 사용합니다.
- OpenDART 전체 재무제표는 `record_type="financials"`와 사업연도, 보고서 코드, `CFS` 또는 `OFS`를 지정합니다.
- SEC는 회사 연락처·제출 이력에 `record_type="company"`, XBRL facts에 `record_type="companyfacts"`를 사용합니다.
- SEC 상세 ID에는 검색 결과의 `cik_str`를 사용하며 AAPL 같은 종목코드를 직접 넣지 않습니다. 공시 링크에는 `record_id=accessionNumber`, `auxiliary_id=CIK`를 전달합니다. Companies House는 `company_number`의 선행 0을 보존하고 `record_type="company"` 또는 `"officers"`만 사용합니다. 영국 재무제표를 DART의 `financials` 형식으로 요청하지 않습니다.
- PDF 원문을 내려받거나 OCR하지 않습니다. 근거 원문이 필요하면 `get_document_link`의 공식 HTML 링크를 제공합니다.
- 인증 오류와 서비스 장애를 구분하려면 `get_source_health`를 사용합니다. 응답이나 보고서에 API 키를 적지 않습니다.
- DART 인증은 MyHarness 루트의 비공개 `API_KEY.env`에 저장한 `DART_API_KEY`(대체 이름 `OPENDART_API_KEY`)를 사용합니다. 웹 실행기는 이를 환경변수로 읽습니다. 키 변경 후 이미 연결된 서버는 재연결합니다. 다른 기업공시 소스의 키로 재사용하지 않습니다.
- 예: `search_catalog(source="opendart", query="삼성전자", limit=2)`에서 반환된 `corp_code`를 회사·공시·재무 조회로 연결합니다. 재무 보고서 코드는 사업보고서 `11011`, 반기 `11012`, 1분기 `11013`, 3분기 `11014`이며 연결재무 `CFS`와 별도재무 `OFS`를 구분합니다.
- 결과에는 공식 출처, 식별자, 조회시각, 기준시점, 개정·완전성 정보를 함께 제시합니다.

## 트리거 경계

- 기업공시·사업보고서·재무제표·XBRL·DART·EDGAR·Companies House 요청에 사용합니다.
- 거시경제 시계열은 `macro-finance`, 국가 간 무역은 `trade-market`, 특허는 `patent-tech`로 보냅니다.
