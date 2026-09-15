# 전체 MCP 실호출 점검 — 2026-09-15

## 결과

- 등록된 패키지 23개: 구현 MCP 14개, 의도적으로 실행을 막은 POSCO placeholder 9개.
- 구현 MCP 14개 모두 연결·실제 데이터 조회 성공. 공개 도구 76종 모두 최소 한 가지 대표 입력으로 호출했다.
- 그룹형 MCP의 소스 28개는 health뿐 아니라 실제 조회도 확인했다. EPO OPS도 현재 자격증명으로 검색·서지·패밀리 조회 8건 통과했다.
- 최종 전체 실행: `PASS 127`, `PLACEHOLDER 9`. PASS에는 시작·리소스·health·데이터 조회가 함께 포함되므로 127개 모두 데이터 조회라는 뜻은 아니다.
- 최종 실행의 Python MCP 12개 HTTP 로그에서는 오류 후 복구가 없었다. 앞선 실행에서는 Semantic Scholar 상세조회 HTTP 429가 1회 발생했고, 별도 연도 필터 검색에서는 HTTP 429 → 429 → 200으로 복구됐다. 마지막 성공으로 이 간헐적 제한이 사라졌다고 판단하지 않는다.
- 이번 실행에서 자격증명 누락으로 차단된 구현 소스는 없었다.

## MCP별 확인 범위

| MCP | 공개 도구 호출 | 실제 확인한 대표 업무 |
|---|---:|---|
| company-disclosure | 5/5 | DART 기업·공시·재무, SEC 공시·기업정보, Companies House 기업·임원 |
| trade-market | 3/3 | 한국 관세청·Census 수출입, WTO 수출입, Eurostat Comext 월별 품목 교역 |
| macro-finance | 3/3 | FRED, ECB, BIS, NY Fed SOFR/RRP, OECD, 일본 e-Stat 시계열·발견한 분류 필터 |
| legislation-regulation | 5/5 | Congress 법안·하위자료, Federal Register 검색·상세, Europarl 절차·이벤트, EUR-Lex, 영국 법안·법령 |
| patent-tech | 4/4 | KIPRIS·OpenAlex·Crossref·Semantic Scholar 검색→ID→상세, EPO 검색→서지·패밀리 |
| environment-industry | 4/4 | Eurostat Prodcom 생산량, EPA ECHO 시설, USDA ERS 변수·연도·주 보고서 |
| development-finance | 3/3 | ADB KIDB 지표 카탈로그·국가별 시계열 |
| worldbank | 6/6 | 국가·지표 검색, 지표 정의, 한국 인구 시계열 |
| comtrade | 6/6 | 국가 검색·미리보기·인증 조회·한국/일본 공통 연도 교역 |
| ecos | 6/6 | 통계표·항목·주요지표·환율·발견한 항목의 범용 시계열 |
| eia | 4/4 | 가격 별칭 카탈로그, WTI, Brent 원시 시리즈 |
| kosis | 6/6 | 검색→표 ID→메타데이터·항목→월별 수치, 통계 설명 |
| korean-law | 10/10 | 법령 검색·조문·별표 목록·인용 검증·판례 상세, 숨은 도구 발견·실행, 정확한 조례 ID의 상위법 분석 |
| national-assembly | 11/11 | 의원·의안·의안 상세·회의·위원회·청원·연구·입법예고·NABO 보고서·원시 API |

placeholder: `posco-calender`, `posco-datalake`, `posco-ecm`, `posco-email`, `posco-erp`, `posco-gih`, `posco-mih`, `posco-ontology`, `posco-plm`. 키를 등록해도 업무 도구 자체가 구현되는 것은 아니며 성공으로 집계하지 않았다.

## 이번에 반영한 개선

1. **조례 선택 지침:** 이름으로 `ordinance_radar`를 바로 호출하면 부분 검색의 첫 결과인 다른 자치구 조례가 선택될 수 있었다. 먼저 자치법규 검색 도구를 발견·실행하고 제목·지자체·시행일을 확인한 ID로 분석하도록 MCP 스킬을 보완했다. 강남구·광진구 두 조례에서 검색→정확한 제목 확인→ID 분석이 성공했다. `NO_PARENT`는 상위법 인용 추출 한계로 구분하고 같은 ID의 본문을 확인하도록 했다. 이름 기반 upstream 자동 선택 구현 자체를 변경한 것은 아니다.
2. **의안 식별자 지침:** 통합 목록의 `items[].의안ID`와 원시 응답의 `BILL_ID`를 구분하고 `bill_detail.bill_id`에 연결하도록 명시했다. 실제 목록 ID로 상세 조회가 성공했다. 최신 의안의 빈 이력은 상세 조회 실패와 구분한다.
3. **공통 MCP 지침:** 과거 키 누락 기록을 현재 상태로 취급하지 않기, health·목록과 데이터 조회 구분, 실제 반환 ID 재사용, 호출량 제한 소스의 직렬 호출·중복 health 방지·Retry-After 준수, 최초 성공과 복구 성공 구분을 시스템 지침에 추가했다.
4. **검증 범위:** 자격증명 검증 스크립트의 EPO 고정 제외를 없애고 검색·서지·패밀리 사례를 추가했다. 도구별 추가 실호출 스크립트를 만들고 전체 검증에 `--http-audit` 옵션을 추가했다.
5. **검사 오탐 수정:** 새 검증 스크립트의 초기 버전이 `0 오류` 및 판결문 본문의 '오류'를 장애로 잘못 판정했다. 본문 단어가 아닌 오류 상태·응답 앞부분의 명시적 오류 표식을 검사하도록 수정한 후 인용 검증·판례 상세가 통과했다. 이 두 건은 MCP 장애가 아니었다.

정상 빈 응답도 보존했다: Census의 특정 수출 조건은 HTTP 204, Congress의 특정 법안 공동발의자 목록은 HTTP 200/빈 배열이었다. 다른 품목·조회 기능에서는 실제 데이터가 반환됐다.

## 검증 근거와 재현

```powershell
python scripts/verify_all_mcps.py --http-audit --output .myharness/ui-checks/mcp-audit-all.json
python scripts/verify_credential_mcp_workflows.py --output .myharness/ui-checks/mcp-audit-credentials.json
python scripts/verify_mcp_tool_workflows.py --output .myharness/ui-checks/mcp-audit-tools.json
python scripts/verify_mcp_packages.py --require-runtime-deps
```

같은 소스를 중복 호출하지 않도록 위 명령은 순서대로 실행한다. Python HTTP 계측은 상태·소요시간만 저장하며 URL·키는 기록하지 않는다. Node 기반 한국 법령·국회는 HTTP 계측 대상이 아니므로 이들의 내부 HTTP 최초 시도 성공까지 증명하지는 않는다.

이번 실제 결과는 `.myharness/ui-checks/`에 보관했다.

- `mcp-audit-20260915-all.json`: 최초 전체 검사, Semantic Scholar 429 보존.
- `mcp-audit-20260915-http-final.json`: 최종 전체 검사 및 같은 접두사의 서버별 HTTP 로그.
- `mcp-audit-20260915-credentials.json`: EPO 추가 전 시작한 69개 검사 — 정상 66, 정상 빈 응답 2, HTTP 재시도 복구 1.
- `mcp-audit-20260915-epo.json`: EPO 8개 검사 통과.
- `mcp-audit-20260915-tools.json`: World Bank·Comtrade·ECOS·EIA·KOSIS 추가 검사 19건 통과 및 초기 법령 검사 진단.
- `mcp-audit-20260915-legal-recheck.json`: 국회 목록→상세 2건 통과 및 조례 검색 후보 확인 기록.
- `mcp-audit-20260915-ordinance-final.json`: 한국 법령 최종 11건 통과.
- `mcp-audit-20260915-coverage.json`: 실제 호출 기록과 공개 스키마 76종 대조, 미호출 도구 없음.

패키지 23개 구성·의존성 검증 및 UTF-8 검사 통과. 수정 범위의 공백 검사와 Python 컴파일 검사 통과. 시스템 프롬프트·한국 법령 회귀 검사는 **30 통과, 1 실패**다. 실패는 기존 진행 문구 계약 검사 `test_build_system_prompt_plans_substantial_tasks_first`이며 이번 MCP 지침을 제거한 기존 내용에서도 요구 문구가 없음을 확인했다. 무관한 기존 UI 변경의 공백 오류도 전체 diff 검사에 남아 있어 수정하지 않았다.

공개 도구별 대표 호출을 검증했으며 모든 입력 조합, `execute_tool` 뒤의 모든 숨은 법령 도구·도메인, 모델이 지침을 따르는 전체 대화 흐름, 다른 PC의 clone 실행까지 검증한 것은 아니다. 기존 변경을 보존했으며 이번 작업에서 commit/push하지 않았다.
