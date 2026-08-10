# 공식 데이터 MCP 구현·결격 검토

작성일: 2026-08-10  
대상: 금융·무역·법률·특허·산업·환경·개발금융 공식 데이터  
원칙: 핵심 결과가 JSON, XML, CSV, SDMX, XBRL, JSON-LD로 반환되는 소스만 운영형 MCP로 승인한다. PDF·이미지·OCR, 로그인 세션, CAPTCHA, 비공개 내부 API가 필요하면 제외한다.

API 키·계정의 실제 신청 순서와 국가별 발급 사이트는 [MCP API 키·계정 신청 가이드](MCP_CREDENTIAL_APPLICATION_GUIDE.md)에 별도로 정리했다.

## 1. 결론

후보 사이트별로 MCP를 하나씩 설치하지 않고 업무 목적별 7개 `skill-mcp`로 묶었다. 기존에 정상 동작하는 Comtrade, EIA, ECOS, KOSIS, World Bank, 대한민국 국회, 대한민국 법령 MCP는 수정하거나 중복 구현하지 않았다.

| 그룹 | 신규 서버 | 구현된 공식 소스 | 기존 MCP로 라우팅 |
|---|---|---|---|
| 기업공시 | `company-disclosure` | OpenDART, SEC EDGAR, Companies House | 없음 |
| 무역시장 | `trade-market` | 관세청, U.S. Census, WTO, Eurostat COMEXT | Comtrade |
| 거시금융 | `macro-finance` | FRED, ECB, BIS, NY Fed, OECD, 일본 e-Stat | ECOS, KOSIS |
| 법률규제 | `legislation-regulation` | Congress.gov, Federal Register, EP Open Data, EUR-Lex CELLAR, UK Bills, legislation.gov.uk | 국회, 한국법령 |
| 특허기술 | `patent-tech` | KIPRISPlus, EPO OPS, OpenAlex, Crossref, Semantic Scholar | 없음 |
| 산업환경 | `environment-industry` | Eurostat PRODCOM, EPA ECHO, USDA ERS ARMS | EIA, KOSIS, ECOS |
| 개발금융 | `development-finance` | ADB KIDB SDMX | World Bank |

`energy-commodities`를 별도 신규 서버로 만들지 않은 이유는 보유 키로 동작하는 기존 EIA MCP가 있고, 나머지 후보 다수가 구독형·대용량 파일·스프레드시트·미문서화 API이기 때문이다. 억지로 묶으면 이름은 그럴듯하지만 운영 가능한 도구가 아니라 다운로드 크롤러가 된다.

## 2. 판정 기준

| 등급 | 의미 |
|---|---|
| D1 | 키가 없거나 단순 무료 키인 안정 REST/CSV. 구현·운영이 쉬움 |
| D2 | 코드표, 페이지네이션, 단위·기간, SDMX/JSON-stat 처리가 필요 |
| D3 | OAuth, 복잡한 온톨로지, 계정 승인, 주기적 키 갱신이 필요 |
| D4 | 세션·브라우저·포털 내부 호출·파일 동기화가 필요해 유지보수가 큼 |
| X | 종료 예정, OCR/PDF 중심, 계약·비용·접근권 문제로 운영형 MCP 부적합 |

공통 구현 조건은 다음과 같다.

- 키는 저장소와 `.mcp/*.json`에 넣지 않고 환경변수 또는 MyHarness 사용자 설정에서만 읽는다.
- 결과에는 `source`, `source_id`, `retrieved_at`, `as_of`, `unit`, `revision`, `completeness`, `license`를 넣는다.
- 식별자를 URL 경로에 넣기 전에 형식을 검증하고, 대용량 API는 기간·국가·품목 필터를 강제한다.
- 키가 URL 쿼리에 들어가는 API가 있으므로 HTTP 클라이언트의 요청 URL INFO 로그를 차단한다.
- PDF는 내려받지 않고 공식 HTML 링크만 반환한다. XML/JSON 대체 표현이 있으면 그것만 사용한다.

## 3. API 키 발급·한국 접근성

아래의 “실확인”은 2026-08-10 이 환경에서 실제 공식 엔드포인트를 호출한 결과다. 키 값은 문서와 저장소에 기록하지 않았다.

| 소스 | 필요한 자격증명 | 한국 사용자 발급 난도 | 만료·운영 부담 | 현재 상태 |
|---|---|---|---|---|
| OpenDART | `DART_API_KEY` | 매우 쉬움. 국내 개인 이메일 가입 | 일반 키, 호출량 관리 | 사용자 설정에 등록, 회사·공시·2025 재무 실확인 |
| SEC EDGAR | `SEC_USER_AGENT` | 키 없음. 실제 연락 가능한 조직·연락처 문자열 필요 | 접근속도·엣지 차단 준수 | 현재 미설정. 어댑터·응답 축소·모의 계약 테스트만 통과했으며 실API 보증 대상에서 제외 |
| Companies House | `COMPANIES_HOUSE_API_KEY` | 쉬운 편. 무료 계정·애플리케이션 | 키 관리 | 어댑터·테스트 완료, 키 없음 |
| 관세청 | `KCS_TRADE_API_KEY` 또는 `DATA_GO_KR_API_KEY` | 매우 쉬움. 공공데이터포털 개발계정 자동승인 | 운영계정은 별도 심의 가능 | 어댑터 완료, 별도 관세청 키 없음 |
| Census Trade | `CENSUS_API_KEY` | 쉬움. 이메일로 무료 발급 | 현재 공식 안내상 키 필요 | 어댑터 완료, 키 없음 |
| WTO | `WTO_API_KEY` | 보통. 개발자 포털 무료 가입 | 쿼터·캐시 필요 | 어댑터 완료, 키 없음 |
| Eurostat COMEXT/PRODCOM | 없음 | 제한 없음 | 필터 없는 대용량 조회만 주의 | 두 데이터셋 실확인 |
| FRED | `FRED_API_KEY` | 쉬움. 무료 계정 | 안정적 | 어댑터 완료, 키 없음 |
| ECB·BIS·NY Fed·OECD | 없음 | 제한 없음 | SDMX 차원·분당 호출 관리 | 모두 시계열 실확인 |
| 일본 e-Stat | `ESTAT_JP_APP_ID` | 보통. 영문 가입 가능 | 표 ID 탐색이 어려움 | 어댑터 완료, ID 없음 |
| Congress.gov | `CONGRESS_API_KEY` 또는 `DATA_GOV_API_KEY` | 쉬움. 이메일 기반 무료 발급 | 일반 data.gov 쿼터 | 어댑터 완료, 키 없음 |
| Federal Register | 없음 | 제한 없음 | 검색 범위·페이지 관리 | 검색 실확인 |
| EP Open Data·EUR-Lex | 없음 | 제한 없음 | JSON-LD·CELLAR XML 모델이 복잡 | 어댑터 완료, 구조화 응답 실확인 |
| UK Bills·legislation.gov.uk | 없음 | 제한 없음 | 없음 | JSON·Atom/XML 실확인 |
| KIPRISPlus | `KIPRIS_API_KEY` | 한국 사용자는 쉬운 편. 회원가입 후 상품 신청 | 상품별 승인·쿼터·과다호출 차단 | 어댑터 완료, 키 없음 |
| EPO OPS | `EPO_OPS_CLIENT_ID`, `EPO_OPS_CLIENT_SECRET` | 보통. EPO 계정과 앱 등록 | OAuth·용량 제한 | 인증·검색·패밀리 어댑터 완료, 자격증명 없음 |
| OpenAlex | `OPENALEX_API_KEY` | 쉬움. 무료 계정에서 즉시 복사 | 무료 일일 크레딧, 초과 유료 | 운영 어댑터는 키 필수. 현재 키가 없어 실API 보증 대상에서 제외 |
| Crossref | 없음, `CROSSREF_MAILTO` 권장 | 제한 없음 | 연락 이메일·예의 있는 호출 필요 | 검색 실확인 |
| Semantic Scholar | `SEMANTIC_SCHOLAR_API_KEY`를 운영상 필수로 취급 | 무료 신청 가능하나 승인·한도 차이 | 공유 출구 IP는 무키 429 | 키 설정 전 사용 불가. 무키 성공을 가정하지 않도록 health와 실제 도구 모두 차단 |
| USDA ERS | `USDA_ERS_API_KEY` 또는 `DATA_GOV_API_KEY` | 쉬움. 유효 이메일 자동 발급 | 데이터셋별 스키마 | ARMS 어댑터 완료, 키 없음 |
| ADB KIDB | 없음 | 제한 없음 | 공식 분당 20회 | 카탈로그·SDMX CSV 실확인 |

사용자가 제공한 KOSIS, Comtrade, ECOS, EIA 키는 기존 MCP가 사용하므로 새 서버에 복제하지 않았다. 기존 MCP의 자격증명 저장 방식은 별도 보안 정비 대상으로 남아 있다.

## 4. 그룹별 구현 결과와 난이도

### 4.1 `company-disclosure` — D2

- OpenDART의 기업코드 ZIP/XML, 회사개황, 공시목록, 단일회사 전체계정 재무 JSON을 구현했다.
- SEC는 회사 submissions와 companyfacts JSON을 구현했다. 공식 User-Agent가 없으면 호출하지 않는다.
- Companies House는 회사검색, 프로필, 임원, filing history를 구현했다.
- PDF 공시를 읽지 않으며 DART/SEC/Companies House 공식 HTML 링크만 반환한다.
- OpenDART 키는 저장소가 아닌 사용자 설정에만 있다. 과거 세션 명령에 키가 남은 이력이 있으므로 운영 전 키 교체를 권고한다.

### 4.2 `trade-market` — D2

- 관세청은 공공데이터포털 [품목별 국가별 수출입실적 15100475](https://www.data.go.kr/data/15100475/openapi.do)를 사용한다. 기존 검토본의 15102108은 잘못된 데이터셋 번호였다.
- Census는 수입·수출 HS JSON, WTO는 지표 카탈로그·시계열, Eurostat는 COMEXT `DS-045409` JSON-stat을 구현했다.
- 글로벌 다국가 비교는 기존 Comtrade를 사용한다.
- USITC는 구현하지 않았다. Login.gov MFA 계정, 저장 쿼리 생성, 6개월마다 수동 만료되는 토큰을 요구하고 Census와 핵심 무역 데이터가 중복된다. 반기 갱신 담당자와 고유한 관세 분석 요구가 확정될 때만 D3 과제로 승인한다.
- UNCTADstat은 안정된 범용 질의 API보다 bulk 파일 중심이므로 포털·파일 동기화가 필요한 별도 배치 과제다.

### 4.3 `macro-finance` — D2

- FRED, ECB, BIS, NY Fed, OECD, 일본 e-Stat을 한 시계열 도구로 묶었다.
- ECB 환율, BIS CPI, NY Fed SOFR, OECD 경기선행지표를 실제 조회했다.
- 한국 시계열은 기존 ECOS·KOSIS를 우선한다.
- FRB DDP는 2026~2027년 기능 폐지와 FRED 전환이 공지된 종료 예정 자산이므로 X 판정이다.
- “유럽 금융여건·환율·강수요”는 “철강 수요” 오타로 보이지만 ECB가 철강 수요를 직접 제공하지 않는다. 실제 생산은 PRODCOM을 사용한다.

### 4.4 `legislation-regulation` — D2~D3

- Congress 법안·Action·위원회·공동발의·요약·텍스트 버전, Federal Register 규칙·예고, EP 절차·이벤트, UK Bills 단계·간행물을 구현했다.
- EUR-Lex는 느리고 복잡한 제목 전체 SPARQL 검색을 노출하지 않는다. EP에서 얻은 CELEX 번호로 CELLAR의 구조화 XML 메타데이터를 조회한다.
- legislation.gov.uk는 Atom 검색과 법령 XML 메타데이터를 사용한다. 대형 XML 본문 전체를 반환하지 않고 요약 필드만 추출한다.
- 한국은 기존 국회·한국법령 MCP를 사용한다. 국회도서관은 법안 기준 데이터가 아니고 별도 로그인·키 및 PDF 혼재 때문에 조사자료 보조원으로만 평가하며 구현하지 않았다.
- 원문의 `제류안`은 `계류안` 또는 `법률안`으로 수정한다.

### 4.5 `patent-tech` — D2~D3

- KIPRISPlus 키워드 검색·출원번호 서지, EPO OPS CQL 검색·서지·패밀리를 구조화 XML로 구현했다.
- OpenAlex 주제·논문, Crossref DOI, Semantic Scholar 논문·인용 메타데이터를 구현했다.
- 특허 도면·전문 PDF, 논문 PDF, OCR은 사용하지 않는다.
- USPTO ODP는 2026년 구형 Developer Hub 종료 직후이고 USPTO.gov/ID.me 계정·키 정책이 전환 중이다. 새 Patent File Wrapper 계약과 인증이 안정된 뒤 재평가한다.
- WIPO PATENTSCOPE 웹서비스는 구독 조건, 분당 10회 제한, 별도 사용계약이 있고 일부 제공물이 TIFF/OCR이라 X 판정이다. 국제 특허 서지는 EPO OPS로 대체한다.
- Espacenet은 검색 UI이므로 직접 자동화하지 않고 같은 원천의 EPO OPS를 사용한다.

### 4.6 `environment-industry` — D2

- Eurostat PRODCOM `DS-059358`은 reporter·product·time 필터를 강제해 JSON-stat으로 반환한다.
- EPA ECHO는 미국 규제 사업장의 CAA·CWA·RCRA·SDWA 준수, 검사·집행 요약을 JSON으로 반환한다.
- USDA ERS는 ARMS의 변수 카탈로그와 연도·보고서/변수별 surveydata를 구현했다.
- 미국 에너지 가격·생산·재고는 기존 EIA를 사용하고, 한국 산업·물가는 기존 KOSIS/ECOS를 사용한다.

### 4.7 `development-finance` — D2(지표), 프로젝트 포털 X

- ADB KIDB v4 공식 SDMX의 dataflow 지표 검색과 연간 국가 시계열을 구현했다. 실제 필리핀·싱가포르 GDP 4개 관측값을 확인했다.
- World Bank는 기존 MCP를 사용한다.
- IFC, MIGA, AIIB, EBRD, IDB, AfDB의 프로젝트 포털은 상세 프로젝트 레코드에 대한 안정적·문서화된 공용 API가 확인되지 않았다. HTML 검색, 내부 포털 호출, CSV/XLSX 정기 다운로드, PDF E&S 문서를 섞어야 하므로 운영형 MCP에서 제외했다.
- 이 제외는 “데이터가 없다”는 뜻이 아니라 “서버형 MCP로 재현 가능한 공식 API 계약이 없다”는 뜻이다. 프로젝트 문서를 사람이 보는 조사나 승인된 파일의 배치 적재는 별도 사업이다.

## 5. 제외·보류 사유

상사 보고 시 단순히 “어렵다”가 아니라 다음 운영 결격사유로 설명하는 것이 타당하다.

| 대상 | 판정 | 결격 또는 보류 사유 |
|---|---|---|
| FRB DDP | X | 공식 폐기·FRED 이관이 예정되어 신규 개발 시 단기간 내 재개발해야 함 |
| USITC DataWeb | D3 보류 | Login.gov MFA, 저장 쿼리 선행, 토큰 6개월 수동 만료, Census와 중복. 갱신 담당자 없이는 운영 중단이 확정적 |
| ITC Trade Map | X | 일반 공개 API가 아니고 대량 사용은 Comtrade로 안내. 구독·재배포권 불명확 |
| UNCTADstat | 배치 보류 | 안정된 범용 API보다 bulk 다운로드 중심. 실시간 MCP보다 버전 고정 배치 적재가 맞음 |
| UNIDO INDSTAT | X | 공식 문서가 403 우회에 headful Chrome/브라우저 지문 방식을 제시. 무인 서버의 보안·재현성 기준 위반 |
| USPTO ODP | 재평가 | 2026년 구형 포털 종료 및 계정 정책 전환 직후. 인증·엔드포인트가 안정되기 전 구현하면 폐기 위험 큼 |
| WIPO PATENTSCOPE | X | 계약·구독, 매우 낮은 호출 제한, SOAP/TIFF/OCR 비중 때문에 비용 대비 효과가 낮음 |
| IEA | X/계약 전 | 핵심 데이터와 Releases API가 구독·라이선스에 묶임. 공개 사이트 내부 `api.iea.org`는 공식 재사용 API 계약이 아님 |
| IRENA | 보류 | PxWeb 가능성은 있으나 우선 지표와 장기 계약 검증이 필요. 기존 EIA보다 즉시 업무가치가 낮음 |
| JODI | 배치 보류 | 공식 질의 API가 아니라 전체 CSV 다운로드. 월별 파일 버전·재처리 파이프라인이 필요 |
| FAOSTAT | 보류 | 공개 API 문서·호출 경로가 일관되지 않고 이 환경의 공식 API 호스트가 Cloudflare 521. bulk CSV 배치가 더 안정적 |
| AMIS | X | 스프레드시트·시장 보고서 중심이고 FAOSTAT/USDA와 중복. PDF 없이 핵심 기능 충족 어려움 |
| USGS 광물 | 배치 보류 | 범용 질의 API가 없고 연도·품목별 데이터 릴리스 및 PDF/CSV 구조가 다름 |
| Ember | 보류 | 별도 무료 키와 독자 스키마를 추가할 만큼 현재 기존 EIA 대비 우선 가치가 확정되지 않음 |
| Global Energy Monitor | X/계약 전 | 다운로드 신청폼·CAPTCHA·이용조건. 요청 시 자동 수집 불가 |
| EEA | 보류 | DISCODATA/ArcGIS 등 데이터셋별 계약이라 범용 도구가 부정확해짐. 필요한 데이터셋을 먼저 지정해야 함 |
| ECHA | X | 공개 REST는 주로 자체 IUCLID 인스턴스용. ECHA CHEM 전체 자동수집은 권리·차단 위험 |
| IPCC·UNEP | X | 보고서·프로젝트 포털 중심. 핵심 답변에 PDF 본문 추출이 필요 |
| GRI | X | 기업 데이터 API가 아니라 XBRL 보고 규격이므로 단독으로 반환할 기업 레코드가 없음 |
| CDP | X/계약 전 | 데이터 라이선스와 파트너 권한 필요. 일반 공개 기업조회 API가 아님 |
| IFC·MIGA·AIIB·EBRD·IDB·AfDB 프로젝트 | X/별도 배치 | 공식 안정 레코드 API 부재, 내부 웹 호출·CSV/XLSX·PDF 혼합, 증분·누락·버전 검증 불가 |
| IMO GISIS | X | 로그인 세션과 모듈별 권한에 의존하며 범용 공개 API가 아님 |
| AIS 상용 API | 사업 보류 | 위치·항차·Port Call별 과금, 저장·재배포 계약과 예산 확정이 선행돼야 함 |
| 각국 거래소·항만·통계청 일괄 연동 | X | 인증·분류·언어·개정·약관이 기관마다 달라 범용 MCP의 품질·비용·책임을 산정할 수 없음 |

## 6. 검증 현황

| 검증 | 결과 |
|---|---|
| 실패 중심 테스트 | 신규 서버·공통 헬퍼·stdio·오류 전파 174개 통과. 잘못된 기간·식별자·필터·응답 구조·과대 응답·인증 누락·비밀값 반사·XML 외부 엔티티 공격을 포함 |
| 신규 코드 커버리지 | 8개 신규 서버/헬퍼 합계 91%. 서버별 85~97%, 공통 HTTP/보안 헬퍼 95% |
| 반복 안정성 | 동일 174개 테스트를 3회 연속 실행해 매회 전부 통과 |
| 실제 MCP 프로세스 연결 | 7개 서버를 각각 stdio로 기동하고 도구 목록과 리소스를 조회. 서버 오류가 성공 문자열이 아니라 MyHarness 오류 상태로 전달되는 것까지 확인 |
| 전체 MCP 회귀 테스트 | `python -m pytest tests/test_mcp -q`: 220개 통과 |
| 실API 엄격 검증 | `python scripts/verify_official_data_mcps.py`를 최종 수정 후 3회 연속 실행. 매회 `PASS 55 / BLOCKED_NO_CREDENTIAL 13 / FAIL 0` |
| 실API 성공 | OpenDART, Eurostat COMEXT/PRODCOM, ECB, BIS, NY Fed SOFR·RRP, OECD, Federal Register, EP Open Data, EUR-Lex CELLAR, UK Bills, legislation.gov.uk, Crossref, EPA ECHO, ADB KIDB |
| 자격증명 없어 의도적으로 차단 | SEC, Companies House, 관세청, Census, WTO, FRED, e-Stat, Congress, KIPRISPlus, EPO OPS, OpenAlex, Semantic Scholar, USDA ERS |
| 문서 정책 | 신규 서버 모두 PDF 다운로드·OCR 경로 없음 |
| 비밀정보 정책 | 신규 `.mcp/*.json`과 소스에 키 값 없음. 오류에 응답 본문·쿼리 키를 넣지 않으며 상태 도구는 환경변수명과 설정 여부만 반환 |

### 6.1 실제 stdio 검증의 범위

엄격 검증 스크립트는 함수 직접 호출이 아니라 MyHarness가 사용하는 설정을 읽어 7개 Python MCP 프로세스를 실제로 시작한다. 한 번의 검증은 다음 68개 판정으로 구성된다.

- 서버 기동·도구 목록 7개와 overview 리소스 7개: 14개 통과
- 소스별 health 28개: 공식 엔드포인트 실제 성공 15개, 자격증명 미설정으로 네트워크 호출 전 차단 13개
- 대표 업무 흐름 26개: OpenDART 회사·공시·재무, COMEXT, ECB/BIS/NY Fed/OECD, 미국·EU·영국 법률, Crossref, PRODCOM/EPA, ADB를 모두 실제 호출
- 응답 본문은 성공 여부, 지연, 바이트 수만 로그에 남기며 API 키와 전체 데이터는 출력하지 않음

`BLOCKED_NO_CREDENTIAL`은 통과가 아니다. 해당 13개 소스는 파서·인증 헤더·오류 처리의 모의 테스트만 끝난 상태이며, 실제 키가 설정되기 전에는 “사용 가능”으로 보고하면 안 된다. 반대로 자격증명 없이 쓸 수 있는 소스와 현재 등록된 OpenDART는 두 차례 연속 실제 왕복에 성공했다.

### 6.2 엄격 검증에서 실제로 발견·수정한 결함

| 발견 결함 | 사용자에게 나타날 증상 | 수정·회귀 방지 |
|---|---|---|
| Crossref health의 존재하지 않는 함수 참조 | 설치는 되지만 상태 확인 즉시 `NameError` | 실제 호출로 재현 후 함수명 수정, 전용 회귀 테스트 추가 |
| NY Fed RRP의 잘못된 URL | SOFR는 되지만 역레포 조회만 404 | 공식 `rp/results/search.json`과 `operationTypes=Reverse Repo`로 수정하고 실데이터 재검증 |
| EPA ECHO `responseset`을 행 제한으로 오해 | 정상 시설도 빈 결과 | 공식 필드 묶음 `500`을 유지하고 반환 후 로컬 행 제한 적용 |
| 유럽의회 테스트 ID와 실제 `process_id` 형식 불일치 | 테스트 fixture는 통과해도 상세 조회 실패 | 실제 ID `2021-0214`로 절차·이벤트 연속 호출 검증 |
| MCP JSON 객체가 문자열 전용 `filters_json`과 충돌 | 대화형 도구 호출에서 타입 검증 실패 | 문자열과 객체를 모두 받되 허용 필드·스칼라·길이를 검증 |
| MCP 서버의 `isError` 결과를 클라이언트가 정상 문자열로 반환 | 실패했는데 UI와 에이전트가 성공으로 오판 | `McpToolExecutionError`로 승격하고 `ToolResult.is_error=True` 전파 테스트 추가 |
| SEC companyfacts·submissions 원문이 과대 반환될 수 있음 | 한 번의 호출이 수 MB가 되어 모델 문맥·UI 불안정 | 개념·최근 공시·관측치 수를 제한하고 축약 메타데이터를 포함 |
| 외부 XML을 표준 파서로 처리 | 악성·오염 응답의 외부 엔티티 확장 위험 | `defusedxml` 의존성을 명시하고 DART·관세청·법률·특허 XML의 공격 fixture 차단 테스트 추가 |

UK Bills는 실행에 따라 health 또는 검색·상세 조회가 최대 약 21.4초까지 걸렸다. 장애는 아니지만 같은 요청도 수백 ms에서 20초대로 흔들리는 외부 지연 편차가 있으므로 120초 도구 제한을 유지하고, 대량 병렬 호출 대상으로 쓰지 않는다.

## 7. 운영 전 남은 일

1. 필요한 소스만 키를 발급한다. 우선순위는 관세청, FRED, Congress, KIPRISPlus이며 실제 요구가 생길 때 EPO OPS, Companies House, WTO, e-Stat, USDA ERS를 추가한다.
2. SEC `SEC_USER_AGENT`에는 가짜 값이 아니라 담당 조직과 실제 연락 가능한 주소를 설정한다.
3. OpenAlex는 무료 키를 발급하고, Semantic Scholar는 키 승인 전까지 Crossref/OpenAlex로 대체한다.
4. 과거 세션 또는 기존 설정에 평문으로 남은 키는 교체하고, 기존 Comtrade·ECOS·EIA·KOSIS MCP도 사용자 자격증명 저장소로 이관한다.
5. USITC를 추가하라는 요구가 다시 나오면 반기별 토큰 갱신 담당자, Login.gov MFA 운영자, Census로 충족되지 않는 고유 질의를 먼저 문서로 확정한다.

## 8. 최종 권고

현재 7개 신규 그룹과 기존 7개 MCP 조합이면 공식 구조화 데이터의 실용 범위를 충분히 덮는다. 후보를 모두 설치하는 것은 기능 확장이 아니라 자격증명 만료, 포털 변경, 라이선스, PDF/OCR 장애를 운영팀에 넘기는 결과가 된다.

추가 승인 기준은 간단하다. “공식 구조화 API 계약, 한국에서 재현 가능한 인증, 자동 갱신 가능한 자격증명, 명확한 재사용권, PDF/OCR 불필요”를 모두 만족할 때만 새 어댑터를 넣는다. 하나라도 충족하지 못하면 웹 조사나 승인된 파일의 배치 적재로 분리한다.

## 9. 판정에 사용한 주요 공식 근거

아래 링크는 2026-08-10 판정 당시의 공식 문서다. 포털 정책과 인증 조건은 바뀔 수 있으므로 실제 운영 승인 시 다시 확인한다.

| 판단 항목 | 공식 근거 |
|---|---|
| OpenDART API·인증키·호출 규격 | [OpenDART 개발가이드](https://opendart.fss.or.kr/guide/main.do?apiGrpCd=DS001) |
| 관세청 대상 데이터셋 | [공공데이터포털 품목별 국가별 수출입실적](https://www.data.go.kr/data/15100475/openapi.do) |
| 미국 무역 API | [U.S. Census International Trade API](https://www.census.gov/data/developers/data-sets/international-trade.html) |
| USITC 저장 질의·토큰 갱신 부담 | [USITC DataWeb Query API](https://www.usitc.gov/applications/dataweb/api/dataweb_query_api.html) |
| Congress.gov API | [Congress.gov API](https://api.congress.gov/) |
| Federal Register API | [Federal Register REST API](https://www.federalregister.gov/reader-aids/developer-resources/rest-api) |
| 유럽의회 입법 API | [European Parliament Open Data API](https://data.europarl.europa.eu/en/developer-corner/opendata-api) |
| EUR-Lex 구조화 메타데이터 | [CELLAR metadata notices](https://op.europa.eu/en/web/cellar/cellar-data/metadata/metadata-notices) |
| EPO 특허 API | [EPO Open Patent Services](https://www.epo.org/en/searching-for-patents/data/web-services/ops) |
| USPTO 포털 전환 | [USPTO Patent File Wrapper API 안내](https://data.uspto.gov/apis/patent-file-wrapper/application-data) |
| WIPO 사용·계약 조건 | [PATENTSCOPE data products terms](https://www.wipo.int/en/web/patentscope/data/terms) |
| OpenAlex 운영 인증 | [OpenAlex API authentication](https://developers.openalex.org/api-reference/authentication) |
| EPA 시설·규제 API | [EPA ECHO web services](https://echo.epa.gov/tools/web-services) |
| USDA ERS API | [USDA ERS ARMS Data API](https://www.ers.usda.gov/developer/data-apis/arms-data-api) |
| ADB 공식 SDMX API | [ADB Key Indicators Database API](https://kidb.adb.org/api) |
