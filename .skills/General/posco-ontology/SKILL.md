---
name: posco-ontology
description: POSCO 조직·설비·제품·프로세스 기준정보를 탐색하기 위한 연결형 MCP 라우팅입니다.
source: skill-mcp:posco-ontology
---

# POSCO Ontology MCP

`posco-ontology` MCP는 현재 업무 온톨로지와 기준정보 연결을 위한 자리표시자입니다.

- 서버가 비활성 또는 도구가 없으면 온톨로지 연결이 필요하다고 알립니다.
- 연결 후에는 엔터티 유형과 식별자를 먼저 찾고 관계를 단계적으로 탐색합니다.
- 동명이인 조직·설비·제품은 코드와 유효기간으로 구분합니다.
- 답변에는 엔터티 ID, 관계 유형, 기준정보 버전 또는 유효기간을 남깁니다.
