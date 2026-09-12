---
name: kosis
description: KOSIS 국가통계포털의 통계표·수치·메타데이터를 조회하는 MCP 라우팅입니다.
source: skill-mcp:kosis
---

# KOSIS MCP

`kosis` MCP로 국가통계포털 데이터를 조회합니다.

- 주제 탐색은 `list_statistics`, 키워드 검색은 `search_statistics`를 사용합니다.
- `org_id`와 `tbl_id`를 확인한 뒤 `get_table_meta`로 항목·단위를 파악하고 `get_stat_data`로 수치를 조회합니다.
- 통계 정의나 조사 방법이 필요하면 `explain_statistics`를 사용합니다.
- 연결 문제는 `check_connection`으로 확인합니다.
- 인증은 루트의 비공개 `API_KEY.env`에 있는 `KOSIS_API_KEY`를 사용합니다. Base64처럼 보이는 키도 발급 문자열 그대로 전달하고 임의로 디코딩하지 않습니다. 환경파일 변경 후 서버를 재연결합니다.
- `search_statistics(keyword="인구", limit=5)`의 실제 `ORG_ID`·`TBL_ID`를 사용하고, 메타데이터에서 조회 항목·분류·주기 코드를 먼저 확인합니다. 다른 통계표의 코드를 섞거나 검색 결과만으로 통계 수치를 답하지 않습니다.
- 답변에 기관·통계표 ID, 항목, 기간, 단위와 KOSIS 출처를 명시합니다.
