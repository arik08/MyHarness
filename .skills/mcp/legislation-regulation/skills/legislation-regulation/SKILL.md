---
name: legislation-regulation
description: 미국·EU·영국의 법안 진행·행정명령·관세·제재·CBAM·ETS 등 규제 변화를 확인할 때 Congress·Federal Register·유럽의회·EUR-Lex·영국 의회/법령 데이터를 조회합니다. 한국 법령·국회는 해당 전용 MCP를 사용합니다.
source: skill-mcp:legislation-regulation
---

# 해외 법률·의회·규제 MCP

## 첫 호출과 오류 대응

사용할 함수의 [입력 계약·실수 예방·실제 호출 예시](references/function-inputs.md)를 먼저 확인합니다. 다른 호스트로 옮길 때 이 references 폴더도 함께 복사합니다.

- 이 설명서와 현재 도구 스키마를 먼저 확인합니다. 이미 확보한 유효 ID는 재사용하고, 없는 ID·코드·필수 조건만 검색·카탈로그에서 확인합니다. 예시의 대상·기간을 사용자 조건 대신 사용하지 않습니다.
- 검색이 실패해 ID를 얻지 못하면 그 ID가 필요한 상세 호출도 보류합니다. 실패한 선행 단계를 건너뛰어 임의 ID를 만들지 않습니다. 선택 인자는 필요할 때만 전달하며 스키마가 허용하지 않는 null·빈 문자열을 채우지 않습니다.
- 정상 응답 뒤에는 매번 health를 호출하지 않습니다. 400/422·스키마 오류는 설명과 실제 카탈로그를 보고 잘못된 인자만 수정합니다. 401/403은 해당 소스의 인증·승인 문제로, unexpected keyword argument는 설치된 런타임 버전 문제로 구분하고 검색어 변경으로 반복하지 않습니다.
- 429·시간 초과·fetch 실패는 검색 결과 없음이 아닙니다. 도구 내부 재시도가 소진된 뒤 즉시 같은 요청을 반복하지 않습니다. 서버의 Retry-After·복구 안내에 따르고, 복구 근거가 없으면 해당 단계의 한계를 보고합니다. 복합 도구는 각 하위 단계의 오류·누락도 확인합니다.

미국·EU·영국의 법안, 입법 진행, 행정규정과 확정 법령에는 `legislation-regulation` MCP를 사용합니다.

- 미국 법안·발의자·위원회·Action·텍스트 버전은 `source="congress"`를 사용합니다. `record_id`는 `119/hr/1` 형식이며, 세부 내역은 `record_type="actions"`, `committees`, `cosponsors`, `subjects`, `summaries`, `text` 중 하나를 사용합니다.
- Congress `search_records`에서 bill_type을 지정하면 congress도 함께 지정합니다. 반환된 `congress`, `type`, `number`로 상세 ID를 조합합니다. query는 최근 한 페이지의 제목 필터이며 전체 법안 전문 검색이 아닙니다. start_date/end_date는 최종 갱신일 조건이므로 발의일·의결일로 해석하지 않습니다. summaries·cosponsors 등이 비어 있는 법안도 정상이므로 다른 ID로 반복해 채우지 않습니다.
- 미국 행정명령·관세·제재·무역규정·예고는 `source="federal_register"`를 사용합니다.
- EU 입법절차와 단계별 이벤트는 `source="europarl"`을 우선합니다. `process_id`를 얻은 뒤 `record_type="events"`로 진행 이력을 확인합니다.
- CELEX 번호를 이미 알거나 EU 법령 원문·개정·식별자를 확인할 때만 `source="eurlex"`를 사용합니다. 제목 검색은 유럽의회 절차 또는 EUR-Lex 웹 검색으로 CELEX를 먼저 확보합니다.
- 영국 계류 법안·단계·공개 문서는 `source="uk_bills"`, 제·개정 완료 법령과 시행 구조는 `source="uk_legislation"`을 사용합니다.
- 한국 국회·입법예고는 기존 `national-assembly`, 한국 현행 법령·판례는 기존 `korean-law` MCP를 우선합니다. 중복 조회하지 않습니다.
- PDF를 내려받거나 OCR하지 않습니다. `get_record`의 JSON·JSON-LD·Atom·XML을 사용하고, 원문은 `get_document_link`의 공식 HTML 화면으로 안내합니다.
- 키 설정·접속 문제는 `get_source_health`로 확인합니다. Congress.gov만 별도 data.gov API 키가 필요합니다.

## 트리거 경계

- 법안, 의안 진행, 위원회, 표결, 행정명령, 규칙 예고, 관세·제재 규정, CBAM·ETS·세이프가드, 영국 Bills 요청에 사용합니다.
- 기업 공시는 `company-disclosure`, HS 무역 통계는 `trade-market`, 특허는 `patent-tech`로 보냅니다.
