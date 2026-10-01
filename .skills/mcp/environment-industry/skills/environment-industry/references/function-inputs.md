# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

Search product/variable catalogs or return supported official dataset identifiers.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by environment-industry only", "enum": ["eurostat_prodcom", "epa_echo", "usda_ers"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "usda_ers",
    "query": "income",
    "limit": 2
  }
]
```

## query_industry

PRODCOM requires reporter/product/time in filters_json. USDA ERS requires
filters_json={year: YYYY, variable: catalog id} or year + report; other filters
include state, farmtype, category/category_value, category2/category2_value.
Use catalog IDs, scalar values (comma-separated if multiple), not arrays.
limit caps returned rows. Missing/suppressed estimates must not become zero.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by environment-industry only", "enum": ["eurostat_prodcom", "epa_echo", "usda_ers"], "type": "string"}` |
| `dataset` | 선택 | `{"default": "DS-059358", "type": "string"}` |
| `filters_json` | 선택 | `{"anyOf": [{"additionalProperties": true, "type": "object"}, {"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "eurostat_prodcom",
    "filters_json": {
      "reporter": "DE",
      "product": "24102100",
      "indicators": "PRODQNT",
      "time": "2024"
    },
    "limit": 20
  },
  {
    "source": "usda_ers",
    "filters_json": {
      "year": 2023,
      "variable": "kount"
    },
    "limit": 2
  }
]
```

## search_facilities

Search EPA-regulated facilities and return compliance/enforcement summary fields.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `facility_name` | 필수 | `{"type": "string"}` |
| `state` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `registry_id` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "facility_name": "NUCOR",
    "state": "AL",
    "limit": 2
  }
]
```

## get_source_health

Perform a lightweight official endpoint check and safely report credential needs.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by environment-industry only", "enum": ["eurostat_prodcom", "epa_echo", "usda_ers"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "eurostat_prodcom"
  },
  {
    "source": "epa_echo"
  },
  {
    "source": "usda_ers"
  }
]
```
