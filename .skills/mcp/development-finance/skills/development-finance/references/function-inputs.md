# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

Discover ADB codes. Omit dataflow to list official dataflows, then supply
its id to list indicators. catalog_type=economies lists valid economy codes.
Do not pass an indicator name (e.g. GDP) as dataflow; use query to filter names.

**실수 예방:** dataflow를 모르면 생략하여 ID 검색. catalog_type=economies로 국가 코드 검색. 지표명 GDP는 query에, 데이터플로 ID는 dataflow에 전달. HTTP422이면 같은 문자열 반복 금지.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by development-finance only", "enum": ["adb_kidb"], "type": "string"}` |
| `dataflow` | 선택 | `{"default": "", "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 100, "type": "integer"}` |
| `catalog_type` | 선택 | `{"default": "indicators", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "adb_kidb",
    "dataflow": "DF_NA",
    "query": "GDP",
    "limit": 5
  }
]
```

## query_series

Query annual ADB indicators; indicators/economies are plus-separated official codes.

**실수 예방:** dataflow/indicators/economies는 카탈로그의 실제 ID. 국가 ISO 코드를 추측하지 않음. 복수 코드는 + 구분(각20개 이내). start_period/end_period는 4자리 연도 정수, 모두 필수이며 최대50년.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by development-finance only", "enum": ["adb_kidb"], "type": "string"}` |
| `dataflow` | 필수 | `{"type": "string"}` |
| `indicators` | 필수 | `{"type": "string"}` |
| `economies` | 필수 | `{"type": "string"}` |
| `start_period` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `end_period` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "adb_kidb",
    "dataflow": "DF_NA",
    "indicators": "NGDP_XDC",
    "economies": "PHI+SIN",
    "start_period": 2023,
    "end_period": 2024,
    "limit": 10
  }
]
```

## get_source_health

Perform a small no-key query against the official ADB KIDB API.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by development-finance only", "enum": ["adb_kidb"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "adb_kidb"
  }
]
```
