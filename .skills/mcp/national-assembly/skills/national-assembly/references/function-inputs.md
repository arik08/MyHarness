# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## assembly_member

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `name` | 선택 | `{"description": "의원 이름 (부분 일치 검색)", "type": "string"}` |
| `party` | 선택 | `{"description": "정당명", "type": "string"}` |
| `district` | 선택 | `{"description": "선거구명", "type": "string"}` |
| `committee` | 선택 | `{"description": "소속위원회명 (부분 일치)", "type": "string"}` |
| `analyze` | 선택 | `{"description": "true면 발의법안+표결 종합분석 포함 (기본: false)", "type": "boolean"}` |
| `lang` | 선택 | `{"description": "언어: en이면 영문 API 사용 (검색 모드만 지원)", "type": "string", "enum": ["en"]}` |
| `age` | 선택 | `{"description": "대수 (기본: 22 = 제22대 국회)", "type": "number"}` |
| `page` | 선택 | `{"description": "페이지 번호 (기본: 1)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |
| `scope` | 선택 | `{"description": "current=현재 국회(기본), history=역대국회 데이터 조회", "type": "string", "enum": ["current", "history"]}` |
| `mode` | 선택 | `{"description": "party_stats=정당 및 교섭단체 의석수 현황 조회", "type": "string", "enum": ["party_stats"]}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "page_size": 2
  }
]
```

## assembly_bill

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `bill_name` | 선택 | `{"description": "의안명 (부분 일치 검색)", "type": "string"}` |
| `bill_id` | 선택 | `{"description": "의안 ID (지정 시 상세 조회 모드)", "type": "string"}` |
| `proposer` | 선택 | `{"description": "제안자/대표발의자 이름", "type": "string"}` |
| `committee` | 선택 | `{"description": "소관위원회명", "type": "string"}` |
| `status` | 선택 | `{"description": "상태 필터: all(전체), pending(계류), processed(처리완료), recent(최근 본회의). 기본: all", "type": "string", "enum": ["all", "pending", "processed", "recent"]}` |
| `bill_type` | 선택 | `{"description": "의안 유형: alternative(위원회안/대안)", "type": "string", "enum": ["alternative"]}` |
| `keywords` | 선택 | `{"description": "검색 키워드 (쉼표로 구분, 예: \"AI,인공지능\") — 지정 시 track 모드", "type": "string"}` |
| `mode` | 선택 | `{"description": "모드: search(검색), track(추적), stats(통계). 기본: 파라미터로 자동 감지", "type": "string", "enum": ["search", "track", "stats"]}` |
| `include_history` | 선택 | `{"description": "심사 이력 포함 여부 (track 모드, 기본: false)", "type": "boolean"}` |
| `lang` | 선택 | `{"description": "언어: en이면 영문 API 사용 (status=recent 검색 모드만 지원)", "type": "string", "enum": ["en"]}` |
| `age` | 선택 | `{"description": "대수 (예: 22 = 제22대 국회, 기본: 22)", "type": "number"}` |
| `page` | 선택 | `{"description": "페이지 번호 (기본: 1, search 모드)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "page_size": 2
  }
]
```

## assembly_session

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `type` | 선택 | `{"description": "조회 유형. 생략 시 파라미터로 자동 감지", "type": "string", "enum": ["schedule", "meeting", "vote"]}` |
| `date_from` | 선택 | `{"description": "시작 날짜 (YYYY-MM-DD) 또는 연도 (YYYY). schedule: 날짜 필터, meeting: 연도 필터", "type": "string"}` |
| `date_to` | 선택 | `{"description": "종료 날짜 (YYYY-MM-DD). schedule 모드에서 범위 검색 시 사용", "type": "string"}` |
| `meeting_type` | 선택 | `{"description": "회의 종류 (meeting 모드)", "type": "string", "enum": ["본회의", "위원회", "소위원회", "국정감사", "인사청문회", "공청회", "예결위", "특별위", "국정조사", "시정연설", "인사청문", "토론회"]}` |
| `conf_id` | 선택 | `{"description": "회의록 ID (meeting 모드: 상세 조회)", "type": "string"}` |
| `include_explanations` | 선택 | `{"description": "제안설명서 목록 포함 여부 (meeting 모드, 기본: false)", "type": "boolean"}` |
| `keyword` | 선택 | `{"description": "검색 키워드. schedule: 일정 내용, meeting: 안건명/회의명", "type": "string"}` |
| `committee` | 선택 | `{"description": "위원회명 (schedule/meeting 모드)", "type": "string"}` |
| `bill_id` | 선택 | `{"description": "의안 ID (vote 모드: 의원별 표결 상세)", "type": "string"}` |
| `vote_type` | 선택 | `{"description": "본회의 처리안건 유형 (vote 모드)", "type": "string", "enum": ["법률안", "예산안", "결산", "기타"]}` |
| `lang` | 선택 | `{"description": "언어: en이면 영문 API 사용 (schedule 모드만 지원)", "type": "string", "enum": ["en"]}` |
| `age` | 선택 | `{"description": "대수 (기본: 22 = 제22대 국회)", "type": "number"}` |
| `page` | 선택 | `{"description": "페이지 번호 (기본: 1)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "type": "meeting",
    "page_size": 2
  }
]
```

## assembly_org

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `type` | 선택 | `{"description": "조회 유형. lawmaking 선택 시 category로 세부 유형 지정", "type": "string", "enum": ["committee", "petition", "legislation_notice", "press", "lawmaking"]}` |
| `category` | 선택 | `{"description": "lawmaking 세부 유형. legislation(입법현황/계획/예고), admin(행정예고), interpretation(법령해석례), opinion(의견제시사례)", "type": "string", "enum": ["legislation", "admin", "interpretation", "opinion"]}` |
| `committee_name` | 선택 | `{"description": "위원회명 (부분 일치). 지정 시 type=committee 자동 설정", "type": "string"}` |
| `include_members` | 선택 | `{"description": "위원회 위원 명단 포함 여부 (committee_name 지정 시)", "type": "boolean"}` |
| `petition_id` | 선택 | `{"description": "청원 ID (상세 조회). 지정 시 type=petition 자동 설정", "type": "string"}` |
| `petition_status` | 선택 | `{"description": "청원 상태 필터 (기본: pending)", "type": "string", "enum": ["pending", "processed", "all"]}` |
| `bill_name` | 선택 | `{"description": "입법예고 법안명 검색 (부분 일치)", "type": "string"}` |
| `lang` | 선택 | `{"description": "언어: en이면 영문 API 사용 (committee/press 모드 지원)", "type": "string", "enum": ["en"]}` |
| `age` | 선택 | `{"description": "대수 (예: 22)", "type": "number"}` |
| `page` | 선택 | `{"description": "페이지 번호 (기본: 1)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |
| `keyword` | 선택 | `{"description": "검색 키워드 (lawmaking 모든 카테고리 공통, UTF-8 인코딩)", "type": "string"}` |
| `diff` | 선택 | `{"description": "예고상태 (lawmaking legislation): 0=진행중, 1=종료", "type": "string"}` |
| `ls_cls_cd` | 선택 | `{"description": "법령분류코드: AA0101(법률), AA0102(대통령령), AA0103~AA0106(시행령/규칙 등)", "type": "string"}` |
| `cpt_ofi_org_cd` | 선택 | `{"description": "소관부처 코드 (예: 1741000=행안부)", "type": "string"}` |
| `st_dt_fmt` | 선택 | `{"description": "시작일자 (YYYY.MM.DD 형식)", "type": "string"}` |
| `ed_dt_fmt` | 선택 | `{"description": "종료일자 (YYYY.MM.DD 형식)", "type": "string"}` |
| `lm_pln_yy` | 선택 | `{"description": "입법계획 연도 (YYYY 형식, lawmaking legislation plan 모드)", "type": "string"}` |
| `pmt_cls_cd` | 선택 | `{"description": "계획구분코드: AB0201(연초), AB0202(추가)", "type": "string"}` |
| `search_knd` | 선택 | `{"description": "검색구분: schLsNm(법령명), schDs(소관부처), schKwrd(키워드)", "type": "string"}` |
| `srch_txt` | 선택 | `{"description": "검색어 (search_knd와 함께 사용)", "type": "string"}` |
| `detail_seq` | 선택 | `{"description": "상세 조회 시 일련번호 (legislation/notice/plan 구분은 mode 파라미터 참고)", "type": "string"}` |
| `closing` | 선택 | `{"description": "마감여부 (lawmaking admin): N=진행, Y=종료", "type": "string"}` |
| `prd_fr_day` | 선택 | `{"description": "검색기간 시작 (YYYY.MM.DD, lawmaking interpretation)", "type": "string"}` |
| `prd_to_day` | 선택 | `{"description": "검색기간 종료 (YYYY.MM.DD, lawmaking interpretation)", "type": "string"}` |
| `ls_cpt_org` | 선택 | `{"description": "소관기관 코드 (lawmaking interpretation)", "type": "string"}` |
| `sc_fm_dt` | 선택 | `{"description": "시작일자 (YYYY.MM.DD, lawmaking opinion)", "type": "string"}` |
| `sc_to_dt` | 선택 | `{"description": "종료일자 (YYYY.MM.DD, lawmaking opinion)", "type": "string"}` |
| `sc_text_type` | 선택 | `{"description": "검색구분 (lawmaking opinion): caseNm(안건명), caseNo(안건번호), reqOrgNm(요청기관)", "type": "string", "enum": ["caseNm", "caseNo", "reqOrgNm"]}` |
| `sc_text` | 선택 | `{"description": "검색어 (sc_text_type과 함께 사용)", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "type": "lawmaking",
    "category": "legislation",
    "diff": "0",
    "page_size": 2
  }
]
```

## discover_apis

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `keyword` | 선택 | `{"description": "검색 키워드 (예: 회의록, 청원, 예산)", "type": "string"}` |
| `category` | 선택 | `{"description": "카테고리 필터 (예: 국회의원, 의정활동별 공개, 보고서)", "type": "string"}` |
| `page_size` | 선택 | `{"description": "결과 수 (기본: 20)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "page_size": 2
  }
]
```

## query_assembly

**실수 예방:** discover_apis에서 실제 api_code와 해당 API 필터 이름 확인. params는 객체이며 통합 도구의 인자를 그대로 옮기지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `api_code` | 필수 | `{"type": "string", "description": "API 코드 (예: ALLSCHEDULE, nwvrqwxyaytdsfvhu, BILLRCP)"}` |
| `params` | 선택 | `{"description": "API 파라미터 (예: {AGE: 22, BILL_NAME: '교육'})", "type": "object", "propertyNames": {"type": "string"}, "additionalProperties": {"anyOf": [{"type": "string"}, {"type": "number"}]}}` |
| `page` | 선택 | `{"description": "페이지 번호 (기본: 1)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "api_code": "BILLRCP",
    "params": {
      "AGE": 22
    },
    "page_size": 2
  }
]
```

## bill_detail

**실수 예방:** assembly_bill의 items[].의안ID 또는 원시 BILL_ID 사용. 의안번호/BILL_NO 사용 금지. history=[]만으로 상세 실패 판정 금지.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `bill_id` | 필수 | `{"type": "string", "description": "의안 ID (필수)"}` |
| `fields` | 선택 | `{"description": "조회 항목 (기본: 전체). detail, review, history, proposers, meetings, lifecycle", "type": "array", "items": {"type": "string", "enum": ["detail", "review", "history", "proposers", "meetings", "lifecycle"]}}` |
| `age` | 선택 | `{"description": "대수 (예: 22)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 100, 최대: 100)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "bill_id": "PRC_F3EFEE8E6EAD4D878AFCE74D2A64BE",
    "fields": [
      "detail",
      "history"
    ],
    "page_size": 2
  }
]
```

## committee_detail

**실수 예방:** 현재 위원회명을 assembly_org에서 확인. 과거 명칭과 현재 명칭의 관계를 밝힘.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `committee_name` | 선택 | `{"description": "위원회명 (생략 시 전체 목록)", "type": "string"}` |
| `include_members` | 선택 | `{"description": "위원 명단 포함 여부 (committee_name 지정 시 기본: true)", "type": "boolean"}` |
| `include_resources` | 선택 | `{"description": "위원회 부가정보 포함 여부", "type": "boolean"}` |
| `age` | 선택 | `{"description": "대수 (예: 22)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 100, 최대: 100)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "page_size": 2
  }
]
```

## petition_detail

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `petition_id` | 선택 | `{"description": "청원 ID (상세 조회 모드)", "type": "string"}` |
| `mode` | 선택 | `{"description": "모드: search(검색/상세, 기본), stats(청원 통계)", "type": "string", "enum": ["search", "stats"]}` |
| `status` | 선택 | `{"description": "처리상태 필터 (기본: pending). pending=계류, processed=처리완료, all=전체", "type": "string", "enum": ["pending", "processed", "all"]}` |
| `keyword` | 선택 | `{"description": "청원명 검색 키워드", "type": "string"}` |
| `age` | 선택 | `{"description": "대수 (예: 22)", "type": "number"}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "status": "all",
    "page_size": 2
  }
]
```

## research_data

**실수 예방:** source의 enum 확인 후 필요한 자료원만 선택. 하위 자료원 오류를 포함한 응답을 전체 성공으로 판정하지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `keyword` | 필수 | `{"type": "string", "description": "검색 키워드 (필수)"}` |
| `source` | 선택 | `{"description": "검색 대상 (기본: all). library=도서관, research=입법조사처, budget=예산정책처, publications=국회발간물, future=국회미래연구원, all_integrated=4개 기관 통합API", "type": "string", "enum": ["library", "research", "budget", "publications", "future", "all_integrated", "all"]}` |
| `page_size` | 선택 | `{"description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "keyword": "경제",
    "source": "all_integrated",
    "page_size": 2
  }
]
```

## get_nabo

**실수 예방:** type=report만 지원. periodical/recruitments 금지. keyword 생략은 목록, 지정은 검색.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `type` | 선택 | `{"default": "report", "description": "검색 대상: report(보고서)", "type": "string", "enum": ["report"]}` |
| `keyword` | 선택 | `{"description": "검색어 (scSw 파라미터)", "type": "string"}` |
| `page` | 선택 | `{"default": 1, "description": "페이지 번호 (기본: 1)", "type": "number"}` |
| `page_size` | 선택 | `{"default": 20, "description": "페이지 크기 (기본: 20, 최대: 100)", "type": "number"}` |
| `sc_sort` | 선택 | `{"default": "pubDt", "description": "정렬 기준: pubDt(게시일), subj(제목)", "type": "string", "enum": ["pubDt", "subj"]}` |
| `sc_order` | 선택 | `{"default": "desc", "description": "정렬 방향: asc(오름차순), desc(내림차순)", "type": "string", "enum": ["asc", "desc"]}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "type": "report",
    "page_size": 2
  }
]
```
