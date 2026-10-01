---
name: patent-tech
description: 기술동향·선행기술·경쟁사 특허·연구기관·논문 근거가 필요할 때 KIPRISPlus·EPO OPS 특허와 OpenAlex·Crossref·Semantic Scholar 논문·초록·인용 메타데이터를 조회합니다. 전문·PDF 추출은 지원하지 않습니다.
source: skill-mcp:patent-tech
---

# 특허·기술·논문 MCP

## 첫 호출과 오류 대응

사용할 함수의 [입력 계약·실수 예방·실제 호출 예시](references/function-inputs.md)를 먼저 확인합니다. 다른 호스트로 옮길 때 이 references 폴더도 함께 복사합니다.

- 이 설명서와 현재 도구 스키마를 먼저 확인합니다. 이미 확보한 유효 ID는 재사용하고, 없는 ID·코드·필수 조건만 검색·카탈로그에서 확인합니다. 예시의 대상·기간을 사용자 조건 대신 사용하지 않습니다.
- 검색이 실패해 ID를 얻지 못하면 그 ID가 필요한 상세 호출도 보류합니다. 실패한 선행 단계를 건너뛰어 임의 ID를 만들지 않습니다. 선택 인자는 필요할 때만 전달하며 스키마가 허용하지 않는 null·빈 문자열을 채우지 않습니다.
- 정상 응답 뒤에는 매번 health를 호출하지 않습니다. 400/422·스키마 오류는 설명과 실제 카탈로그를 보고 잘못된 인자만 수정합니다. 401/403은 해당 소스의 인증·승인 문제로, unexpected keyword argument는 설치된 런타임 버전 문제로 구분하고 검색어 변경으로 반복하지 않습니다.
- 429·시간 초과·fetch 실패는 검색 결과 없음이 아닙니다. 도구 내부 재시도가 소진된 뒤 즉시 같은 요청을 반복하지 않습니다. 서버의 Retry-After·복구 안내에 따르고, 복구 근거가 없으면 해당 단계의 한계를 보고합니다. 복합 도구는 각 하위 단계의 오류·누락도 확인합니다.

특허와 연구기술 동향에는 `patent-tech` MCP를 사용합니다.

- 한국 특허·실용신안 키워드 검색과 출원번호별 서지는 `source="kipris"`를 사용합니다.
- 유럽·국제 특허 서지와 패밀리는 `source="epo_ops"`를 사용합니다. 검색어는 EPO OPS CQL이며, 패밀리는 `record_type="family"`입니다.
- `get_record(record_type="family")`에서 `data=[]`, `completeness="family_not_available"`가 반환되면 원문 특허의 존재는 확인됐지만 EPO가 패밀리 데이터를 제공하지 않은 상태입니다. `metadata.seed_publications`의 공개정보와 `upstream_status`를 근거로 데이터 범위의 한계를 설명하고, 패밀리가 없거나 인증이 실패했다고 단정하지 않습니다. 검색 결과의 ID를 다른 특허로 바꾸어 성공한 것처럼 보고하지 않습니다.
- EPO 검색 결과의 `record_id`를 그대로 상세 조회에 전달합니다. `publication`은 해당 공개공보의 국가·번호·종류·공개일입니다. 공개번호 하나에 A1/B1 등 여러 공보가 반환될 수 있으므로 `publication.kind`와 날짜를 함께 구분합니다. XML 계층을 보존한 `bibliographic-data`의 `application-reference`·`priority-claims`는 출원·우선권 정보이며 공개정보와 섞지 않습니다. `_attributes`에는 언어·문서번호 형식·패밀리 ID·법적 이벤트 속성이, `_text`에는 속성이 있는 요소의 본문이 들어갑니다. 패밀리의 각 행은 `family-member` 한 건이며 서지가 없는 법적 이벤트 전용 구성원도 포함합니다. 법적 이벤트 이력을 현재 유효한 권리 상태로 단정하지 않습니다.
- 연구 주제·기관·저자·인용 관계는 `source="openalex"`, DOI 등록 메타데이터 확인은 `source="crossref"`, 초록·인용·참고문헌 탐색은 `source="semantic_scholar"`를 사용합니다.
- OpenAlex는 `OPENALEX_API_KEY`가 없으면 검색하지 않고 “기업용 API KEY 신청이 필요합니다”라고 안내합니다. Crossref는 키 없이 사용할 수 있으며 연락용 `CROSSREF_MAILTO` 설정을 권장합니다.
- 동일 기술은 특허와 논문을 분리 검색한 뒤 공개일·출원일·우선일을 구분합니다. 검색 건수만으로 기술우위를 단정하지 않습니다.
- 먼저 `search_catalog` 또는 `search_records`로 ID를 확보하고 `get_record`로 상세 메타데이터를 확인합니다.
- KIPRIS·Semantic Scholar의 `search_catalog`는 지원 기능 목록입니다. 주제 검색은 바로 `search_records`를 사용합니다. KIPRIS 상세에는 `applicationNumber`를 전달하며 등록번호와 혼동하지 않습니다. 연도 필터는 출원일 기준이고, 런타임이 `getAdvancedSearch`의 날짜 범위로 변환합니다. 논문 연도는 출판연도입니다.
- OpenAlex 상세에는 검색에서 반환된 `id`, Semantic Scholar에는 `paperId`, Crossref에는 `DOI`를 그대로 전달합니다. 일반 논문 상세는 `record_type="detail"`이며 `family`는 EPO에만 사용합니다. 인용 횟수와 실제 인용 논문 목록은 구분하며 이 도구에 없는 목록·PDF 기능을 요청하지 않습니다.
- Semantic Scholar는 같은 PC의 MyHarness MCP 프로세스 사이에서도 동일 키의 호출 간격을 제어합니다. 성공한 상세조회는 같은 키·ID에 한해 60초간 재사용하며 응답 metadata에 cache_hit와 cache_age_seconds를 표시합니다. health를 매 검색 전에 호출하지 말고 정상 응답 후에는 바로 그 결과의 ID를 사용합니다. 429가 남으면 키 누락으로 판단하거나 검색어·ID를 바꾸어 우회하지 않고 호출량 제한으로 보고합니다. 외부 앱과 같은 키를 공유하면 이 MCP 밖의 호출까지 제어할 수 없습니다.
- Semantic Scholar는 기업용으로 승인된 `SEMANTIC_SCHOLAR_API_KEY` 등록 후 조회합니다. 키가 없으면 “기업용 API KEY 신청이 필요합니다”라고 안내하고 무인증 호출하지 않습니다. 키가 등록된 상태의 HTTP 429는 키 누락이 아닌 호출량 제한으로 구분합니다.
- Semantic Scholar 검색은 상세 조회와 같은 필드를 요청합니다. 필드가 모두 포함된 검색 결과는 같은 키·ID에 한해 60초간 상세 조회에 재사용하며 `metadata.cache_origin="search"`로 출처를 표시합니다. 일부 필드가 누락됐거나 만료된 검색 결과로 상세 조회를 대신하지 않습니다.
- PDF·도면·전문을 내려받거나 OCR하지 않습니다. 이 MCP는 구조화된 서지·초록·패밀리 메타데이터만 반환합니다.
- WIPO PATENTSCOPE 웹서비스는 일반 공개 API가 아니라 구독·사용조건·호출제한이 있는 별도 상품이므로 이 MCP에 포함하지 않습니다. 국제 특허는 EPO OPS 패밀리로 대체합니다.
- USPTO ODP는 2026년 계정·키 정책 전환과 구형 Developer Hub 종료가 진행 중이므로 안정 계약이 확인되기 전에는 연결하지 않습니다.

## 트리거 경계

- 수소환원제철, CCUS, 희귀가스, 소재·공정 특허, 연구기관, 논문, DOI, 인용·패밀리 요청에 사용합니다.
- 기업 투자·공시는 `company-disclosure`, 법안·규제는 `legislation-regulation`으로 보냅니다.
