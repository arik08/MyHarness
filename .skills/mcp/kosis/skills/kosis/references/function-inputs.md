# 함수별 입력 계약과 실수 예방

현재 패키지의 공개 함수별 설명서입니다. 사용할 함수의 절만 읽습니다. 실제 tools/list 스키마가 변경되면 최신 스키마를 우선합니다. 아래 예시는 2026-10-01 실제 시험에서 반환을 확인한 입력이며, 대상·기간·ID의 영구 유효성을 보장하지 않습니다. 상세 ID는 사용자의 대상 검색 결과로 교체하고, 성공 예시를 다른 요청의 결과로 대신 사용하지 않습니다.

## list_statistics

List KOSIS statistics categories and tables under a service view and parent list ID.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `vw_cd` | 선택 | `{"default": "MT_ZTITLE", "type": "string"}` |
| `parent_id` | 선택 | `{"default": "A", "type": "string"}` |
| `limit` | 선택 | `{"default": 100, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "limit": 2
  }
]
```

## search_statistics

Search KOSIS tables by Korean keyword and return matching table IDs and paths.

**실수 예방:** 검색·목록 응답에서 대상과 식별자를 확인합니다. 검색 실패 시 ID가 필요한 후속 조회를 보류합니다. limit은 필요한 범위만 지정합니다.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `keyword` | 필수 | `{"type": "string"}` |
| `limit` | 선택 | `{"default": 50, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "keyword": "인구",
    "limit": 2
  }
]
```

## get_stat_data

Fetch KOSIS statistical data for an org/table and item/classification filters.

**실수 예방:** org_id/tbl_id는 같은 검색 행에서 취득. prd_se와 start_prd_de/end_prd_de는 해당 표 PRD 메타정보의 주기·기간 코드를 사용. ECOS의 주기 코드나 ISO 날짜를 그대로 복사하지 않음. itm_id/obj_l1 등은 해당 표의 항목·분류 ID.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `org_id` | 필수 | `{"type": "string"}` |
| `tbl_id` | 필수 | `{"type": "string"}` |
| `prd_se` | 선택 | `{"default": "Y", "type": "string"}` |
| `start_prd_de` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `end_prd_de` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `new_est_prd_cnt` | 선택 | `{"anyOf": [{"type": "integer"}, {"type": "null"}], "default": 3}` |
| `itm_id` | 선택 | `{"default": "ALL", "type": "string"}` |
| `obj_l1` | 선택 | `{"default": "ALL", "type": "string"}` |
| `obj_l2` | 선택 | `{"default": "", "type": "string"}` |
| `obj_l3` | 선택 | `{"default": "", "type": "string"}` |
| `obj_l4` | 선택 | `{"default": "", "type": "string"}` |
| `obj_l5` | 선택 | `{"default": "", "type": "string"}` |
| `obj_l6` | 선택 | `{"default": "", "type": "string"}` |
| `obj_l7` | 선택 | `{"default": "", "type": "string"}` |
| `obj_l8` | 선택 | `{"default": "", "type": "string"}` |
| `limit` | 선택 | `{"default": 200, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "org_id": "101",
    "tbl_id": "DT_1B040A3",
    "prd_se": "M",
    "new_est_prd_cnt": 1,
    "limit": 2
  }
]
```

## get_table_meta

Return table metadata. Types: TBL (title), ORG, PRD, ITM, UNIT, CMMT,
SOURCE, WGT, NCD. Human aliases title/items/unit are accepted. API error 30
means the requested metadata is not available, not an authentication failure.

**실수 예방:** meta_type: TBL(제목), ITM(항목), PRD(기간), UNIT(단위), ORG(기관), CMMT, SOURCE, WGT, NCD. title→TBL. 같은 검색 행의 ORG_ID/TBL_ID를 함께 전달. 오류30을 인증 오류로 오인하지 않음.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `org_id` | 필수 | `{"type": "string"}` |
| `tbl_id` | 필수 | `{"type": "string"}` |
| `meta_type` | 선택 | `{"default": "TBL", "type": "string"}` |
| `limit` | 선택 | `{"default": 200, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "org_id": "101",
    "tbl_id": "DT_1B040A3",
    "limit": 2
  }
]
```

## explain_statistics

Return KOSIS survey/statistics explanation metadata by statId or orgId plus tblId.

**실수 예방:** stat_id 또는 org_id와 tbl_id 쌍 중 하나가 필요. 모든 선택 인자를 생략하면 실패.

| 인자 | 필수 | 형식·허용값·기본값 |
|---|---|---|
| `org_id` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `tbl_id` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `stat_id` | 선택 | `{"anyOf": [{"type": "string"}, {"type": "null"}], "default": null}` |
| `meta_itm` | 선택 | `{"default": "All", "type": "string"}` |
| `limit` | 선택 | `{"default": 200, "type": "integer"}` |

**실제 호출 형식 예시** (요청 대상·기간은 바꾸십시오):
```json
[
  {
    "org_id": "101",
    "tbl_id": "DT_1B040A3",
    "limit": 2
  }
]
```

## check_connection

Check whether the KOSIS API is reachable from the current network.

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
