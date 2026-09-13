---
name: eia
description: 유가·천연가스·연료비 추이와 에너지 원가 영향을 분석할 때 미국 EIA의 WTI·Brent·Henry Hub·휘발유·경유 가격 시계열 또는 지정된 EIA series ID를 조회합니다.
source: skill-mcp:eia
---

# U.S. EIA MCP

`eia` MCP로 미국 에너지 통계를 조회합니다.

- WTI, Brent, Henry Hub, 휘발유, 경유는 `list_price_series`로 별칭을 확인한 뒤 `get_energy_price`를 사용합니다.
- 사용자가 EIA series ID를 지정하면 `get_series`를 사용합니다.
- 연결 또는 API 키 오류는 `check_connection`으로 구분합니다.
- 인증은 루트의 비공개 `API_KEY.env`의 `EIA_API_KEY`를 사용하고 키 변경 후 서버를 재연결합니다.
- 예: `get_energy_price(alias="wti", start="2025-01-02", end="2025-01-10", length=10)`. 원유 가격과 천연가스 가격의 단위가 다르므로 반환된 단위를 보존합니다. 발표일·관측일·휴일 및 결측치를 구분합니다.
- 답변에 series ID 또는 별칭, 조회 기간, 단위와 EIA 출처를 밝힙니다.
