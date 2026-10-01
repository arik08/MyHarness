# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_law

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `query` | 필수 | `{"type": "string", "description": "검색할 법령명 (예: '관세법', 'fta특례법', '화관법')"}` |
| `display` | 선택 | `{"default": 50, "description": "최대 결과 개수 (기본 50 — 짧은 법령명 정확매칭 누락 방지)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "query": "개인정보 보호법",
    "display": 5
  }
]
```

## get_law_text

**실수 예방:** search_law의 정확한 대상에서 확보한 mst 또는 lawId 사용. 법령 제목을 ID로 넣지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `mst` | 선택 | `{"description": "법령일련번호 (search_law에서 획득)", "type": "string"}` |
| `lawId` | 선택 | `{"description": "법령ID (search_law에서 획득)", "type": "string"}` |
| `search` | 선택 | `{"description": "조문 제목 검색어. 공백으로 구분한 검색어 중 하나와 일치하는 조문 본문을 반환", "type": "string"}` |
| `jo` | 선택 | `{"description": "조문 번호 (예: '제38조' 또는 '003800')", "type": "string"}` |
| `efYd` | 선택 | `{"description": "시행일자 (YYYYMMDD 형식)", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "mst": "283839",
    "jo": "제1조"
  }
]
```

## ordinance_radar

**실수 예방:** 조례 검색에서 제목·지자체·시행일이 일치하는 ordinSeq 확보. 이름 검색의 첫 결과로 다른 지역 조례를 분석하지 않음. NO_PARENT는 인용 추출 한계.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `ordinSeq` | 선택 | `{"description": "자치법규 일련번호 (search_ordinance 결과의 [번호])", "type": "string"}` |
| `id` | 선택 | `{"description": "ordinSeq 별칭 — 힌트가 id=로 안내하는 경우 대응", "type": "string"}` |
| `ordinanceName` | 선택 | `{"description": "자치법규명 — 지정 시 검색 후 첫 결과 사용 (예: '서울특별시 광진구 주차장 설치 및 관리 조례')", "type": "string"}` |
| `query` | 선택 | `{"description": "ordinanceName 별칭 — 자연어 조례명으로 검색 (search_law 등 다른 도구와 규약 통일)", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "ordinSeq": "2152155"
  }
]
```

## get_annexes

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `lawName` | 필수 | `{"type": "string", "description": "법령명 (예: '관세법'). 별표를 바로 지정하려면 '... 별표4' 또는 '... 별표1의2'처럼 함께 입력 가능"}` |
| `knd` | 선택 | `{"description": "1=별표, 2=서식, 3=부칙별표, 4=부칙서식, 5=전체", "type": "string", "enum": ["1", "2", "3", "4", "5"]}` |
| `bylSeq` | 선택 | `{"description": "별표번호 (예: '000300'). 지정 시 해당 별표 파일을 다운로드하여 텍스트로 추출", "type": "string"}` |
| `annexNo` | 선택 | `{"description": "별표 번호 (예: '4', '별표4', '제4호'). bylSeq 대체 입력", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "lawName": "개인정보 보호법 시행령",
    "knd": "1"
  }
]
```

## legal_research

**실수 예방:** task를 목적에 맞춤: 법체계 law_system, 처분근거 action_basis+scenario=penalty. 좁은 질문에 full_research 남용 금지. 하위 단계의 fetch 실패·시간 제한은 완전 성공과 구분.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `query` | 선택 | `{"description": "자연어 질문/법령명/키워드 (예: '음주운전 처벌 기준', '관세법 체계'). document_review 외 모든 task에서 필수", "type": "string"}` |
| `task` | 선택 | `{"default": "full_research", "description": "리서치 유형 (도구 설명의 task 표 참조). 미지정 시 full_research", "type": "string", "enum": ["full_research", "law_system", "action_basis", "dispute_prep", "amendment_track", "ordinance_compare", "procedure_detail", "document_review"]}` |
| `scenario` | 선택 | `{"description": "확장 시나리오. 미지정 시 쿼리에서 자동 감지. task별 호환: law_system=delegation·impact &#124; action_basis=penalty &#124; amendment_track=timeline·time_travel &#124; ordinance_compare=compliance &#124; full_research=customs·action_plan &#124; procedure_detail=manual", "type": "string", "enum": ["delegation", "impact", "penalty", "timeline", "time_travel", "compliance", "customs", "action_plan", "manual"]}` |
| `domain` | 선택 | `{"description": "[dispute_prep] 전문 분야 (tax=조세심판, labor=노동위, privacy=개인정보위, competition=공정위). 미지정 시 자동 감지", "type": "string", "enum": ["tax", "labor", "privacy", "competition", "general"]}` |
| `articles` | 선택 | `{"description": "[law_system] 함께 조회할 조문 번호 (예: ['제38조'])", "type": "array", "items": {"type": "string"}}` |
| `parentLaw` | 선택 | `{"description": "[ordinance_compare] 상위 법령명. 미지정 시 자동 검색", "type": "string"}` |
| `mst` | 선택 | `{"description": "[amendment_track] 법령일련번호 (알고 있으면)", "type": "string"}` |
| `lawId` | 선택 | `{"description": "[amendment_track] 법령ID (알고 있으면)", "type": "string"}` |
| `fromDate` | 선택 | `{"description": "[time_travel] 비교 시작 시점 YYYYMMDD", "type": "string", "pattern": "^\\d{8}$"}` |
| `toDate` | 선택 | `{"description": "[time_travel] 비교 종료 시점 YYYYMMDD", "type": "string", "pattern": "^\\d{8}$"}` |
| `text` | 선택 | `{"description": "[document_review 전용·필수] 검토할 계약서/약관 전문 텍스트", "type": "string"}` |
| `maxClauses` | 선택 | `{"description": "[document_review] 최대 분석 조항 수 (기본 15)", "type": "number", "minimum": 1, "maximum": 30}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "query": "개인정보 보호법",
    "task": "law_system"
  }
]
```

## legal_analysis

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `mode` | 필수 | `{"type": "string", "enum": ["verify_citations", "cite_check", "applicable_law", "impact_map"], "description": "분석 유형 (도구 설명의 mode 표 참조)"}` |
| `text` | 선택 | `{"description": "[verify_citations 필수] 검증할 법률 텍스트 (LLM 답변/계약서 등 조문 인용 포함 문자열)", "type": "string"}` |
| `caseNumber` | 선택 | `{"description": "[cite_check 필수] 사건번호 (예: '2013다61381', 문장 포함 가능)", "type": "string"}` |
| `lawName` | 선택 | `{"description": "[applicable_law·impact_map 필수] 법령명 (예: '민법', '도로교통법')", "type": "string"}` |
| `jo` | 선택 | `{"description": "[impact_map 필수, applicable_law 선택] 조문 번호 (예: '제103조', '제10조의2')", "type": "string"}` |
| `date` | 선택 | `{"description": "[applicable_law 필수] 기준일 — 행위·계약·처분 시점 (예: '2023-05-10', '20230510')", "type": "string"}` |
| `maxCitations` | 선택 | `{"description": "[verify_citations] 검증할 최대 인용 개수 (기본 15, 많을수록 느림)", "type": "number", "minimum": 1, "maximum": 30}` |
| `display` | 선택 | `{"description": "[cite_check] 후속 인용 판례 최대 표시 수 (기본 20)", "type": "number", "minimum": 1, "maximum": 50}` |
| `deepScan` | 선택 | `{"description": "[cite_check] 후속 인용 상위 판례 본문 정밀 스캔 (기본 true, false면 빠르지만 변경·폐기 감지 생략)", "type": "boolean"}` |
| `includeOrdinances` | 선택 | `{"description": "[impact_map] 자치법규 인용 검색 포함 (기본 true, false면 전국 조례 팬아웃 생략)", "type": "boolean"}` |
| `includeMermaid` | 선택 | `{"description": "[impact_map] mermaid 그래프 코드 출력 (기본 true)", "type": "boolean"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "mode": "verify_citations",
    "text": "개인정보 보호법 제15조",
    "maxCitations": 1
  }
]
```

## discover_tools

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `intent` | 필수 | `{"type": "string", "description": "찾고 싶은 도구의 의도 또는 카테고리 (예: '공정위', '조약', '용어', '헌재')"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "intent": "자치법규"
  }
]
```

## execute_tool

**실수 예방:** discover_tools에서 반환된 전문 도구 이름과 스키마를 확인. params에는 그 전문 도구 인자만 전달.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `tool_name` | 필수 | `{"type": "string", "description": "실행할 도구 이름 (discover_tools로 확인한 이름)"}` |
| `params` | 필수 | `{"type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {}, "description": "도구에 전달할 파라미터 객체"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "tool_name": "search_ordinance",
    "params": {
      "query": "서울특별시 강남구 주차장 설치 및 관리 조례",
      "display": 10
    }
  }
]
```

## search_decisions

**실수 예방:** domain 필수. 판례 precedent, 법령해석 interpretation 등 스키마 enum에서 선택.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `domain` | 필수 | `{"type": "string", "enum": ["precedent", "interpretation", "tax_tribunal", "customs", "nts", "constitutional", "admin_appeal", "ftc", "pipc", "nlrc", "acr", "appeal_review", "acr_special", "school", "public_corp", "public_inst", "treaty", "english_law"], "description": "도메인 선택 (enum 값 참조)"}` |
| `query` | 선택 | `{"description": "검색 키워드", "type": "string"}` |
| `display` | 선택 | `{"description": "결과 수 (기본20)", "default": 20, "type": "number", "minimum": 1, "maximum": 100}` |
| `page` | 선택 | `{"description": "페이지 (기본1)", "default": 1, "type": "number", "minimum": 1}` |
| `sort` | 선택 | `{"description": "정렬: lasc/ldes/dasc/ddes/nasc/ndes", "type": "string"}` |
| `options` | 선택 | `{"description": "도메인별 옵션. prec:{court,caseNumber,fromDate,toDate} tax_tribunal:{cls,gana,dpaYd,rslYd} customs:{inq,rpl,gana,explYd} constitutional:{caseNumber} interpretation:{fromDate,toDate} treaty:{cls,natCd,eftYd,concYd}", "type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {}}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "domain": "precedent",
    "query": "개인정보",
    "display": 2
  }
]
```

## get_decision_text

**실수 예방:** search_decisions에서 확보한 ID와 동일 domain 사용. 사건번호 표시문구를 내부 ID 대신 사용하지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `domain` | 필수 | `{"type": "string", "enum": ["precedent", "interpretation", "tax_tribunal", "customs", "nts", "constitutional", "admin_appeal", "ftc", "pipc", "nlrc", "acr", "appeal_review", "acr_special", "school", "public_corp", "public_inst", "treaty", "english_law"], "description": "도메인 선택 (enum 값 참조)"}` |
| `id` | 필수 | `{"type": "string", "description": "일련번호/ID (search 결과에서 획득)"}` |
| `full` | 선택 | `{"description": "true=본문 전문 그대로. 미지정=이유/전문 섹션 계단식 축약 (판시·요지·주문은 항상 full)", "type": "boolean"}` |
| `options` | 선택 | `{"description": "도메인별 옵션. treaty:{chrClsCd:'010202'(한)/'010203'(영)} english_law:{mst,lawName} prec/constitutional/admin_appeal/interpretation:{caseName}", "type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {}}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "domain": "precedent",
    "id": "624225"
  }
]
```
