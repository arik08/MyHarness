---
name: posco-datalake
description: POSCO 경영·생산·재무 정형 데이터를 조회하기 위한 연결형 MCP 라우팅입니다.
source: skill-mcp:posco-datalake
---

# POSCO Datalake MCP

`posco-datalake` MCP는 현재 사내 데이터레이크 연결을 위한 자리표시자입니다.

- 서버가 비활성 또는 도구가 없으면 보안 승인과 실제 연결이 필요하다고 알립니다.
- 연결 후에는 데이터셋·테이블·기간·조직·지표를 먼저 확인하고 최소 범위로 조회합니다.
- 스키마와 단위를 확인하지 않은 채 서로 다른 수치를 합치지 않습니다.
- 답변에는 테이블 또는 데이터셋, 필터, 기준시각과 단위를 남깁니다.
