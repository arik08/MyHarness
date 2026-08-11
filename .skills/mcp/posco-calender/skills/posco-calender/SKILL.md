---
name: posco-calender
description: POSCO 회의·보고 일정·업무 마일스톤을 조회하기 위한 연결형 MCP 라우팅입니다.
source: skill-mcp:posco-calender
---

# POSCO Calendar MCP

`posco-calender` MCP는 현재 사내 일정 시스템 연결을 위한 자리표시자입니다.

- 서버가 비활성 또는 도구가 없으면 실제 데이터가 연결되지 않았다고 명확히 알립니다.
- 연결 후에는 기간, 참석자, 조직, 일정 유형을 필요한 범위로만 좁혀 조회합니다.
- 권한 밖 일정이나 민감 정보를 추정하거나 생성하지 않습니다.
- 답변에는 조회 기간과 연결된 원본 일정 식별자를 남깁니다.
