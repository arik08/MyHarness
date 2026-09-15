# API 키 추가 MCP 기능 검증 — 2026-09-15

## 후속 변경

사용자 요청으로 NABO 정기간행물·채용 기능을 제거했다. 도구 스키마·내부 클라이언트·검증 대상에서 제외했으며, 보고서 조회와 키워드 검색만 유지한다. 아래 71건 결과는 제거 전 진단 기록이다.

## 결과

실제 MyHarness MCP stdio 경로로 13개 소스의 71개 시나리오를 실행했다. EPO는 키 미등록으로 제외했다. 연결 점검만으로 데이터 조회 성공을 판정하지 않았다.

- 정상 응답 65건, 정상 빈 결과 2건.
- Semantic Scholar: health 1건 실패(HTTP 429), 검색 1건은 내부 HTTP 재시도 후 성공. 첫 요청 성공 조건은 미충족이다.
- NABO: 보고서와 키워드 조회 성공. 정기간행물·채용 2건은 현재 키에 대한 HTTP 401 / INVALID_KEY로 차단됐다.
- 임의의 모든 입력 조합을 검증한 것은 아니다. 카탈로그 → 반환 ID → 상세조회, 기간·방향·필터 변형 및 각 공개 조회 기능을 검증했다.

| 소스 | 정상 | 정상 빈 결과 | 남은 문제 |
|---|---:|---:|---|
| Companies House | 6 | 0 | 없음 |
| SEC | 8 | 0 | 없음 |
| 한국 관세청 | 4 | 0 | 없음 |
| Census | 4 | 1 | 없음 |
| WTO | 4 | 0 | 없음 |
| FRED | 3 | 0 | 없음 |
| e-Stat | 4 | 0 | 없음 |
| Congress | 10 | 1 | 없음 |
| KIPRIS | 6 | 0 | 없음 |
| OpenAlex | 6 | 0 | 없음 |
| Semantic Scholar | 4 | 0 | 실패 1, 재시도 후 성공 1 |
| USDA ERS | 4 | 0 | 없음 |
| NABO | 2 | 0 | 권한 차단 2 |

## 수정 내용

- WTO: 올바른 지표/데이터 엔드포인트, 기간·국가 코드 계약, Dataset 추출, 실제 응답 문자 인코딩 처리.
- Census: HTTP 204를 정상적인 데이터 없음으로 처리. 다른 소스의 잘못된 JSON까지 빈 결과로 숨기지 않는다.
- Companies House: 임원 목록의 요청/반환 개수 제한과 식별자 지침 보완.
- KIPRIS: 출원연도 검색을 공식 고급검색의 applicationDate 범위로 전달. API 오류 헤더를 특허 레코드로 반환하지 않는다.
- USDA: 중첩 데이터 행 추출·개수 제한, 변수 abb/보고서 이름/state.code 사용 지침.
- e-Stat: 단일 객체 응답을 목록으로 정규화. 무시되던 ISO 기간 인자는 거절하고 공식 시간 코드 필터를 안내.
- Congress: 조회 상한과 최종 수정일 필터 전달, 최근 목록의 로컬 제목 검색이라는 범위 명시.
- Semantic Scholar: 프로세스 사이의 동일 키 호출 간격 공유, Retry-After 존중, 성공 상세조회 60초 캐시. 외부 서버의 429가 완전히 제거되지는 않았다.
- NABO: 거부된 기능의 반복 요청을 연결 수명 동안 차단하고 다른 기능은 계속 사용. 오류 로그의 인증 키 노출 제거. 번들 및 재현 패치 갱신.

## 검증 및 재현

```powershell
python scripts/verify_credential_mcp_workflows.py --output .myharness/ui-checks/credential-functions-final-verified.json
```

- 원본 결과: `.myharness/ui-checks/credential-functions-final-verified.json`.
- Python MCP의 HTTP 상태를 별도 기록해 내부 재시도 성공도 분리한다. NABO Node 번들은 HTTP 계측 대상이 아니며, 권한 차단 반복 방지는 별도 단위 테스트로 확인했다.
- 관련 Python 회귀 테스트: 187 통과, 기존 설정 검사 5 실패. 실패는 현재 mcp.json에 직접 등록된 자격증명과 기존 무자격증명 설정 계약의 충돌이다. 해당 설정이나 검사를 변경해 숨기지 않았다.
- 설정 검사 6개를 제외한 기능 검사: 186 통과. NABO TypeScript 단위 테스트 1 통과 및 빌드 성공.
- 구현된 MCP 패키지 14개 연결 성공, placeholder 9개 제외. UTF-8 검사와 diff 공백 검사 통과.

## 남은 조치

1. NABO의 정기간행물·채용 기능은 사용자 요청으로 제거되어 승인 확인이 필요하지 않다.
2. Semantic Scholar는 5초 간격과 중복 조회 방지 후에도 429가 남는다. 동일 키를 쓰는 외부 클라이언트의 호출량 및 제공자 제한 확인이 필요하다. 완전한 첫 요청 성공으로 보고할 수 없다.

모든 변경은 로컬 작업트리에 남겼으며 commit/push하지 않았다.
