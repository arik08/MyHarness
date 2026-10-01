# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

Inspect supported source variables, indicators, and fixed dataset identifiers.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by trade-market only", "enum": ["customs_kr", "census", "wto", "eurostat_comext"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "wto",
    "query": "ITS_MTV_AX",
    "limit": 2
  },
  {
    "source": "customs_kr",
    "query": "",
    "limit": 2
  },
  {
    "source": "census",
    "query": "",
    "limit": 2
  }
]
```

## query_trade

Query trade with source-native codes. WTO uses numeric economy codes (e.g. 410),
and the indicator determines flow/frequency; use its product classification.
WTO TOTAL uses the indicator's default products, not a synthetic aggregate.

**실수 예방:** 관세청 partner=ISO2·월별 기간 최대12개월. Census=숫자 CTY_CODE. WTO reporter/partner=숫자3자리; 연·분기·월의 시작/끝 단위 일치. COMEXT는 국가·품목·기간 제한. 다른 소스의 코드체계 복사 금지.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by trade-market only", "enum": ["customs_kr", "census", "wto", "eurostat_comext"], "type": "string"}` |
| `flow` | 필수 | `{"type": "string"}` |
| `start_period` | 필수 | `{"type": "string"}` |
| `end_period` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `product` | 선택 | `{"default": "TOTAL", "type": "string"}` |
| `reporter` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `partner` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `frequency` | 선택 | `{"default": "M", "type": "string"}` |
| `indicator` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "wto",
    "flow": "exports",
    "reporter": "410",
    "indicator": "ITS_MTV_AX",
    "product": "MAIS",
    "start_period": "2023",
    "end_period": "2024",
    "limit": 5
  },
  {
    "source": "eurostat_comext",
    "flow": "imports",
    "start_period": "2025-01",
    "end_period": "2025-01",
    "product": "7208",
    "reporter": "DE",
    "partner": "US",
    "indicator": "VALUE_IN_EUROS",
    "limit": 20
  },
  {
    "source": "customs_kr",
    "flow": "exports",
    "limit": 3,
    "partner": "US",
    "product": "7208",
    "start_period": "2025-01",
    "end_period": "2025-02"
  },
  {
    "source": "census",
    "flow": "imports",
    "limit": 3,
    "partner": "5800",
    "product": "7208",
    "start_period": "2025-01",
    "end_period": "2025-02"
  }
]
```

## get_source_health

Check a trade source or report that its required credential is not configured.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by trade-market only", "enum": ["customs_kr", "census", "wto", "eurostat_comext"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "customs_kr"
  },
  {
    "source": "census"
  },
  {
    "source": "wto"
  },
  {
    "source": "eurostat_comext"
  }
]
```
