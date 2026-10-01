# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

Search series or datasets and return identifiers needed by query_series.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by macro-finance only", "enum": ["fred", "ecb", "bis", "nyfed", "oecd", "estat_jp"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "fred",
    "query": "federal funds",
    "limit": 2
  },
  {
    "source": "estat_jp",
    "query": "population",
    "limit": 2
  }
]
```

## query_series

FRED requires series_id and ISO start_period/end_period. SDMX requires dataset
and source-native series key. e-Stat uses the catalog @id as series_id and table-native
filters_json (cdArea, cdCat01, cdTime, cdTimeFrom, cdTimeTo); get codes from returned
CLASS_INF before filtering. Do not send ISO start_period/end_period for e-Stat.

**실수 예방:** FRED=시리즈 ID+ISO 날짜, SDMX=공식 dataset과 차원 순서. e-Stat은 @id와 CLASS_INF 기반 filters_json; ISO start_period/end_period 사용 금지. 소스별 상세 규칙은 SKILL.md 참고.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by macro-finance only", "enum": ["fred", "ecb", "bis", "nyfed", "oecd", "estat_jp"], "type": "string"}` |
| `series_id` | 필수 | `{"type": "string"}` |
| `start_period` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `end_period` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `dataset` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |
| `filters_json` | 선택 | `{"anyOf": [{"additionalProperties": true, "type": "object"}, {"type": "string"}, {"type": "null"}], "default": null}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "ecb",
    "series_id": "D.USD.EUR.SP00.A",
    "dataset": "EXR",
    "start_period": "2025-01-02",
    "end_period": "2025-01-10",
    "limit": 5
  },
  {
    "source": "bis",
    "series_id": "A.DE.",
    "dataset": "WS_LONG_CPI",
    "start_period": "2023",
    "end_period": "2024",
    "limit": 5
  },
  {
    "source": "nyfed",
    "series_id": "SOFR",
    "start_period": "2025-01-02",
    "end_period": "2025-01-10",
    "limit": 5
  },
  {
    "source": "oecd",
    "series_id": "KOR.M.LI...AA...H",
    "dataset": "OECD.SDD.STES,DSD_STES@DF_CLI",
    "start_period": "2024-01",
    "end_period": "2024-02",
    "limit": 5
  },
  {
    "source": "fred",
    "series_id": "FEDFUNDS",
    "limit": 3,
    "start_period": "2023-01-01",
    "end_period": "2024-12-31"
  },
  {
    "source": "estat_jp",
    "series_id": "0004031788",
    "limit": 3
  }
]
```

## get_source_health

Check a macro source or safely report its missing credential.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by macro-finance only", "enum": ["fred", "ecb", "bis", "nyfed", "oecd", "estat_jp"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "fred"
  },
  {
    "source": "ecb"
  },
  {
    "source": "bis"
  },
  {
    "source": "nyfed"
  },
  {
    "source": "oecd"
  },
  {
    "source": "estat_jp"
  }
]
```
