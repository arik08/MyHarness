# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## preview_trade_data

Fetch UN Comtrade public preview trade data without requiring an API key.

**실수 예방:** freq_code=A의 period는 YYYY, M은 YYYYMM. YYMMDD나 ISO 일자 금지. reporter_code는 숫자 문자열. 선택 인자에 null 대신 생략. 국가 코드는 search_reporters에서 확인.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `reporter_code` | 필수 | `{"type": "string"}` |
| `period` | 필수 | `{"type": "string"}` |
| `cmd_code` | 선택 | `{"default": "TOTAL", "type": "string"}` |
| `flow_code` | 선택 | `{"default": "X", "type": "string"}` |
| `partner_code` | 선택 | `{"default": "0", "type": "string"}` |
| `type_code` | 선택 | `{"default": "C", "type": "string"}` |
| `freq_code` | 선택 | `{"default": "A", "type": "string"}` |
| `classification_code` | 선택 | `{"default": "HS", "type": "string"}` |
| `partner2_code` | 선택 | `{"default": "0", "type": "string"}` |
| `customs_code` | 선택 | `{"default": "C00", "type": "string"}` |
| `mot_code` | 선택 | `{"default": "0", "type": "string"}` |
| `include_desc` | 선택 | `{"default": true, "type": "boolean"}` |
| `limit` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "reporter_code": "410",
    "period": "2023",
    "cmd_code": "72",
    "limit": 2
  }
]
```

## get_trade_data

Fetch UN Comtrade data endpoint results. Requires UN_COMTRADE_API_KEY or COMTRADE_API_KEY.

**실수 예방:** freq_code=A의 period는 YYYY, M은 YYYYMM. YYMMDD나 ISO 일자 금지. reporter_code는 숫자 문자열. 선택 인자에 null 대신 생략. 국가 코드는 search_reporters에서 확인.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `reporter_code` | 필수 | `{"type": "string"}` |
| `period` | 필수 | `{"type": "string"}` |
| `cmd_code` | 선택 | `{"default": "TOTAL", "type": "string"}` |
| `flow_code` | 선택 | `{"default": "X", "type": "string"}` |
| `partner_code` | 선택 | `{"default": "0", "type": "string"}` |
| `type_code` | 선택 | `{"default": "C", "type": "string"}` |
| `freq_code` | 선택 | `{"default": "A", "type": "string"}` |
| `classification_code` | 선택 | `{"default": "HS", "type": "string"}` |
| `partner2_code` | 선택 | `{"default": "0", "type": "string"}` |
| `customs_code` | 선택 | `{"default": "C00", "type": "string"}` |
| `mot_code` | 선택 | `{"default": "0", "type": "string"}` |
| `include_desc` | 선택 | `{"default": true, "type": "boolean"}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "reporter_code": "410",
    "period": "2023",
    "cmd_code": "72",
    "limit": 2
  }
]
```

## latest_common_annual_trade_data

Fetch the latest annual period that has rows for every requested reporter.

Use this for cross-country comparisons where all reporters must share one period. The
returned selectedPeriod is the newest common year found, not necessarily the latest
calendar year.

**실수 예방:** 선행 검색·카탈로그에서 확인한 동일 대상의 코드와 아래 필수 인자를 사용합니다. 응답의 빈 데이터·부분 실패·완전성 정보를 구분합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `reporter_codes` | 필수 | `{"items": {"type": "string"}, "type": "array"}` |
| `cmd_code` | 선택 | `{"default": "TOTAL", "type": "string"}` |
| `flow_code` | 선택 | `{"default": "M", "type": "string"}` |
| `partner_code` | 선택 | `{"default": "0", "type": "string"}` |
| `latest_year` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `lookback_years` | 선택 | `{"default": 5, "type": "integer"}` |
| `type_code` | 선택 | `{"default": "C", "type": "string"}` |
| `classification_code` | 선택 | `{"default": "HS", "type": "string"}` |
| `partner2_code` | 선택 | `{"default": "0", "type": "string"}` |
| `customs_code` | 선택 | `{"default": "C00", "type": "string"}` |
| `mot_code` | 선택 | `{"default": "0", "type": "string"}` |
| `include_desc` | 선택 | `{"default": true, "type": "boolean"}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "reporter_codes": [
      "410",
      "392"
    ],
    "cmd_code": "72",
    "latest_year": 2023,
    "lookback_years": 1,
    "limit": 2
  }
]
```

## list_reporters

List UN Comtrade reporter areas and ISO codes.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `limit` | 선택 | `{"default": 300, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "limit": 2
  }
]
```

## search_reporters

Search UN Comtrade reporter areas by name, numeric code, or ISO code.

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

## check_connection

Check whether UN Comtrade public preview API is reachable from the current network.

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
