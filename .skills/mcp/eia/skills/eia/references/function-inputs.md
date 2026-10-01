# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## get_series

Fetch EIA seriesid data such as PET.RWTC.D or NG.RNGWHHD.D.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `series_id` | 필수 | `{"type": "string"}` |
| `start` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `end` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `length` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "series_id": "PET.RBRTE.D",
    "length": 2
  }
]
```

## get_energy_price

Fetch common energy price series by alias: wti, brent, henry_hub, gasoline_regular, diesel.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `alias` | 필수 | `{"type": "string"}` |
| `start` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `end` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `length` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "alias": "wti",
    "length": 2
  }
]
```

## list_price_series

List built-in EIA energy price aliases and series IDs.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| 없음 | — | 빈 객체 `{}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {}
]
```

## check_connection

Check whether EIA is reachable and the configured API key works.

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
