# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

Describe supported record types or list a small source-native catalog.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by legislation-regulation only", "enum": ["congress", "federal_register", "europarl", "eurlex", "uk_bills", "uk_legislation"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "congress",
    "limit": 2
  }
]
```

## search_records

Search records. Congress: congress is required with bill_type (hr/s/etc.);
query is a local title filter over one recent API page, not full-text search.
start_date/end_date filter last update time, not introduction/enactment dates.
Use returned congress/type/number to build get_record ID, e.g. 119/hr/1.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by legislation-regulation only", "enum": ["congress", "federal_register", "europarl", "eurlex", "uk_bills", "uk_legislation"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |
| `congress` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `bill_type` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `start_date` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `end_date` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "federal_register",
    "query": "steel",
    "limit": 2
  },
  {
    "source": "uk_bills",
    "query": "",
    "limit": 2
  },
  {
    "source": "uk_legislation",
    "query": "steel",
    "limit": 2
  },
  {
    "source": "congress",
    "congress": 119,
    "bill_type": "hr",
    "limit": 2
  }
]
```

## get_record

Get one record plus optional actions, events, stages, or publications.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by legislation-regulation only", "enum": ["congress", "federal_register", "europarl", "eurlex", "uk_bills", "uk_legislation"], "type": "string"}` |
| `record_id` | 필수 | `{"type": "string"}` |
| `record_type` | 선택 | `{"default": "detail", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "federal_register",
    "record_id": "2026-20048"
  },
  {
    "source": "europarl",
    "record_id": "2021-0214"
  },
  {
    "source": "eurlex",
    "record_id": "32023R0956"
  },
  {
    "source": "uk_bills",
    "record_id": "3973"
  },
  {
    "source": "uk_legislation",
    "record_id": "ukpga/2025/18"
  },
  {
    "source": "congress",
    "record_id": "118/hr/2617",
    "record_type": "detail"
  }
]
```

## get_document_link

Return an official HTML viewer link; never download or OCR PDFs.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by legislation-regulation only", "enum": ["congress", "federal_register", "europarl", "eurlex", "uk_bills", "uk_legislation"], "type": "string"}` |
| `record_id` | 필수 | `{"type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "congress",
    "record_id": "118/hr/2617"
  }
]
```

## get_source_health

Perform a lightweight official endpoint check and report credential presence safely.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by legislation-regulation only", "enum": ["congress", "federal_register", "europarl", "eurlex", "uk_bills", "uk_legislation"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "congress"
  },
  {
    "source": "federal_register"
  },
  {
    "source": "europarl"
  },
  {
    "source": "eurlex"
  },
  {
    "source": "uk_bills"
  },
  {
    "source": "uk_legislation"
  }
]
```
