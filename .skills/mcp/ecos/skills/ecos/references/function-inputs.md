# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## get_exchange_rate

Fetch daily KRW exchange rates. Dates accept YYYYMMDD or YYYY-MM-DD.

**실수 예방:** start_date/end_date: YYYYMMDD(8자리) 또는 YYYY-MM-DD. 240102 같은 YYMMDD(6자리)는 금지. JPY100은 100엔 단위. 시작일≤종료일; 휴일은 빈 관측 가능.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `currency` | 선택 | `{"default": "USD", "type": "string"}` |
| `start_date` | 선택 | `{"default": "20240101", "type": "string"}` |
| `end_date` | 선택 | `{"default": "20241231", "type": "string"}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "currency": "USD",
    "start_date": "20250102",
    "end_date": "20250103",
    "limit": 2
  }
]
```

## get_statistic_data

Fetch ECOS rows. cycle D: YYYYMMDD/ YYYY-MM-DD, M: YYYYMM/YYYY-MM,
Q: YYYYQ1..YYYYQ4, A: YYYY. Invalid dates/ranges fail before network access.

**실수 예방:** cycle D: YYYYMMDD 또는 YYYY-MM-DD, M: YYYYMM 또는 YYYY-MM, Q: YYYYQ1~YYYYQ4, A: YYYY. YYMMDD와 존재하지 않는 날짜 금지. stat_code→list_stat_tables, item_code→같은 표의 list_stat_items. 주기를 바꾸면 날짜 형식도 함께 변경.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `stat_code` | 필수 | `{"type": "string"}` |
| `cycle` | 필수 | `{"type": "string"}` |
| `start` | 필수 | `{"type": "string"}` |
| `end` | 필수 | `{"type": "string"}` |
| `item_code1` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `item_code2` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `item_code3` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `item_code4` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "stat_code": "731Y001",
    "cycle": "D",
    "start": "20250102",
    "end": "20250103",
    "item_code1": "0000001",
    "limit": 2
  }
]
```

## get_key_statistics

Return ECOS key statistics, including recent KRW exchange-rate headline values.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `limit` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "limit": 2
  }
]
```

## list_stat_tables

List ECOS statistic tables and codes.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "limit": 2
  }
]
```

## list_stat_items

List ECOS item codes for one statistic table.

**실수 예방:** stat_code는 list_stat_tables에서 받은 통계표 코드. 항목 코드나 통계표 제목을 넣지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `stat_code` | 필수 | `{"type": "string"}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "stat_code": "731Y001",
    "limit": 2
  }
]
```

## check_connection

Check whether ECOS is reachable and the configured API key works.

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
