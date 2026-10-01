# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## search_catalog

OpenAlex searches research topics. Other sources return supported operations,
not papers/patents; use search_records for subject keywords.

**실수 예방:** KIPRIS/Semantic Scholar는 기능 목록만 제공. 실제 주제 검색은 search_records로 진행. 카탈로그 성공을 외부 검색 성공으로 오인하지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by patent-tech only", "enum": ["kipris", "epo_ops", "openalex", "crossref", "semantic_scholar"], "type": "string"}` |
| `query` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "kipris",
    "query": "",
    "limit": 2
  },
  {
    "source": "epo_ops",
    "limit": 2
  },
  {
    "source": "openalex",
    "query": "hydrogen",
    "limit": 2
  },
  {
    "source": "semantic_scholar",
    "query": "",
    "limit": 2
  }
]
```

## search_records

Search patent bibliographies or papers. KIPRIS year bounds filter application
dates using advanced search (one bound means that exact year). EPO uses CQL dates
inside query. OpenAlex/Crossref/Semantic Scholar accept publication year bounds.
Use returned applicationNumber/record_id/id/paperId/DOI unchanged for get_record.
EPO publication identifies the returned publication; nested XML fields retain
separate application, priority, party, language and legal-event contexts.

**실수 예방:** EPO query는 CQL. KIPRIS 기간은 출원연도, 논문 기간은 출판연도. source를 바꾸면서 동일 검색 구문·ID를 재사용하지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by patent-tech only", "enum": ["kipris", "epo_ops", "openalex", "crossref", "semantic_scholar"], "type": "string"}` |
| `query` | 필수 | `{"type": "string"}` |
| `limit` | 선택 | `{"default": 20, "type": "integer"}` |
| `start_year` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |
| `end_year` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": null}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "openalex",
    "query": "hydrogen steel",
    "limit": 2
  },
  {
    "source": "crossref",
    "query": "hydrogen steel",
    "limit": 2
  },
  {
    "source": "semantic_scholar",
    "query": "hydrogen steel",
    "limit": 2
  },
  {
    "source": "kipris",
    "query": "수소",
    "limit": 2
  },
  {
    "source": "epo_ops",
    "query": "ti=\"hydrogen\"",
    "limit": 2
  }
]
```

## get_record

Get metadata from a search result ID: KIPRIS applicationNumber (not registerNumber),
OpenAlex id, Semantic Scholar paperId, Crossref DOI. record_type=detail works for all;
bibliography is patent-only, family is EPO-only. A confirmed publication may have
no family data: data=[] with metadata.empty_reason=family_not_available explicitly
reports that coverage gap; it does not establish that the patent has no family.
No PDF download or reference-list tool.

**실수 예방:** KIPRIS=applicationNumber(등록번호 아님), EPO=record_id, OpenAlex=id, Crossref=DOI, Semantic Scholar=paperId. family는 EPO만 지원. family_not_available는 확인된 데이터 미제공, 인증 실패나 패밀리 부존재로 단정 금지.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by patent-tech only", "enum": ["kipris", "epo_ops", "openalex", "crossref", "semantic_scholar"], "type": "string"}` |
| `record_id` | 필수 | `{"type": "string"}` |
| `record_type` | 선택 | `{"default": "detail", "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "openalex",
    "record_id": "https://openalex.org/W2090832912"
  },
  {
    "source": "crossref",
    "record_id": "10.1016/b978-0-08-009697-1.50013-2"
  },
  {
    "source": "semantic_scholar",
    "record_id": "aad95ea538904ce94358fa94af3cace09aadd15e"
  },
  {
    "source": "kipris",
    "record_id": "1020230139991"
  },
  {
    "source": "epo_ops",
    "record_id": "EP4813500",
    "record_type": "bibliography"
  }
]
```

## get_source_health

Perform a lightweight official endpoint check and safely report credential needs.

**실수 예방:** 진단용입니다. 정상 조회마다 반복하지 않습니다. 소스별 인증 상태와 실제 데이터 유무는 별개입니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `source` | 필수 | `{"description": "Source served by patent-tech only", "enum": ["kipris", "epo_ops", "openalex", "crossref", "semantic_scholar"], "type": "string"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "source": "kipris"
  },
  {
    "source": "epo_ops"
  },
  {
    "source": "openalex"
  },
  {
    "source": "crossref"
  },
  {
    "source": "semantic_scholar"
  }
]
```
