# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

Search company identifiers before requesting filings or financial data.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by company-disclosure only", "enum": ["opendart", "sec", "companies_house"], "type": "string"}` |
| `query` | 필수 | `{"type": "string"}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "opendart",
    "query": "삼성전자",
    "limit": 2
  },
  {
    "source": "companies_house",
    "query": "marine",
    "limit": 2
  },
  {
    "source": "sec",
    "query": "Apple",
    "limit": 2
  }
]
```

## search_records

Search disclosure records; identifier means corp code, CIK, or company number by source.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by company-disclosure only", "enum": ["opendart", "sec", "companies_house"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `identifier` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `start_date` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `end_date` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "opendart",
    "identifier": "00126380",
    "start_date": "2025-01-01",
    "end_date": "2026-08-10",
    "limit": 3
  },
  {
    "source": "companies_house",
    "identifier": "03684484",
    "limit": 2
  },
  {
    "source": "sec",
    "identifier": "1418121",
    "limit": 2
  }
]
```

## get_record

Get company data using the ID returned by search_catalog.
opendart: 8-digit corp_code; record_type company or financials (business_year required).
sec: cik_str/CIK; company/submissions or companyfacts; not a ticker symbol.
companies_house: company_number (preserve leading zeros); company or officers.

**실수 예방:** DART=corp_code, SEC=CIK(종목코드 아님), Companies House=company_number(선행0 보존). record_type은 해당 소스가 지원하는 유형만. DART financials는 연도·보고서 코드·CFS/OFS 구분.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by company-disclosure only", "enum": ["opendart", "sec", "companies_house"], "type": "string"}` |
| `record_id` | 필수 | `{"type": "string"}` |
| `record_type` | 선택 | `{"default": "company", "type": "string"}` |
| `business_year` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `report_code` | 선택 | `{"default": "11011", "type": "string"}` |
| `financial_statement` | 선택 | `{"default": "CFS", "type": "string"}` |
| `limit` | 선택 | `{"default": 1000, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "opendart",
    "record_id": "00126380",
    "record_type": "company"
  },
  {
    "source": "companies_house",
    "record_id": "03684484",
    "record_type": "company",
    "limit": 2
  },
  {
    "source": "sec",
    "record_id": "1418121",
    "record_type": "company",
    "limit": 2
  }
]
```

## get_document_link

Return an official viewer or registry link without downloading PDF documents.

**실수 예방:** SEC는 record_id=accessionNumber, auxiliary_id=CIK. 회사 ID와 문서 ID를 혼동하지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by company-disclosure only", "enum": ["opendart", "sec", "companies_house"], "type": "string"}` |
| `record_id` | 필수 | `{"type": "string"}` |
| `auxiliary_id` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "opendart",
    "record_id": "20260810000353"
  },
  {
    "source": "companies_house",
    "record_id": "03684484"
  },
  {
    "source": "sec",
    "record_id": "1418121"
  }
]
```

## get_source_health

Perform a lightweight official endpoint check and report credential presence safely.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by company-disclosure only", "enum": ["opendart", "sec", "companies_house"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "opendart"
  },
  {
    "source": "sec"
  },
  {
    "source": "companies_house"
  }
]
```
