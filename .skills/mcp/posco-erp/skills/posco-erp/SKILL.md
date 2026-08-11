---
name: posco-erp
description: POSCO ERP/POSPIA의 생산·구매·판매·출하·정산 데이터를 조회하기 위한 연결형 MCP 라우팅입니다.
source: skill-mcp:posco-erp
---

# POSCO ERP MCP

`posco-erp` MCP는 현재 ERP/POSPIA 연결을 위한 자리표시자입니다.

- 서버가 비활성 또는 도구가 없으면 업무 권한과 실제 연결이 필요하다고 알립니다.
- 연결 후에는 회사·조직·전표 또는 주문·품목·기간·상태를 먼저 확인합니다.
- 코드 체계, 통화, 단위, 취소·수정 상태를 확인하지 않은 수치는 확정값으로 쓰지 않습니다.
- 답변에는 원본 업무 식별자, 필터, 기준시각과 단위를 남깁니다.
