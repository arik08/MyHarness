# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## list_countries

List World Bank countries and economies, optionally filtered by region, income level, or lending type code.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `region` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `income_level` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `lending_type` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 300, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "limit": 2
  }
]
```

## search_countries

Search World Bank country/economy metadata by name, ISO code, capital city, region, or income group.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `keyword` | 필수 | `{"type": "string"}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "keyword": "Korea",
    "limit": 2
  }
]
```

## search_indicators

Search World Bank indicators by ID, name, or source note. Source 2 is World Development Indicators.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `keyword` | 필수 | `{"type": "string"}` |
| `source_id` | 선택 | `{"default": 2, "type": "integer"}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "keyword": "population",
    "limit": 2
  }
]
```

## get_indicator_metadata

Return World Bank metadata for one indicator ID such as NY.GDP.MKTP.CD.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `indicator` | 필수 | `{"type": "string"}` |
| `source_id` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "indicator": "SP.POP.TOTL",
    "limit": 2
  }
]
```

## fetch_indicator_data

Fetch World Bank time-series data for one country/economy and indicator.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `country` | 필수 | `{"type": "string"}` |
| `indicator` | 필수 | `{"type": "string"}` |
| `start_year` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `end_year` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `frequency` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `source_id` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": 2}` |
| `limit` | 선택 | `{"default": 200, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "country": "KOR",
    "indicator": "SP.POP.TOTL",
    "start_year": 2022,
    "end_year": 2023,
    "limit": 2
  }
]
```

## check_connection

Check whether the World Bank API is reachable from the current network.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| 없음 | — | 빈 객체 `{}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {}
]
```
