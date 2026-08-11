# MCP API 키·계정 신청 가이드

작성일: 2026-08-10  
대상: MyHarness에 구현된 공식 데이터 MCP 중 현재 자격증명이 없어 실API 검증이 차단된 소스

## 현재 발급·검증 상태 (2026-08-11)

API 키와 개인 연락처는 저장소가 아니라 `~/.myharness/settings.json`의 사용자 MCP 설정에만 저장한다.

| 대상 | 현재 상태 | 실사용 검증 |
|---|---|---|
| api.data.gov 공통 키 | 발급·등록 완료 | Congress 법안 상세 조회와 USDA ERS 변수 검색을 MCP stdio 경로로 통과 |
| U.S. Census Data API | 발급·이메일 활성화·등록 완료 | HS 7208 월별 수입 조회를 MCP stdio 경로로 통과 |
| OpenAlex | 계정 생성·키 등록 완료 | 수소·철강 논문 검색을 MCP stdio 경로로 통과 |
| SEC EDGAR | 실제 조직·연락처 User-Agent 등록 완료 | 기업 검색과 공시 목록 조회를 MCP stdio 경로로 통과 |
| FRED | Google 계정 선택 단계에서 사용자 조작 대기 | 아직 차단 |
| 일본 e-Stat | 이메일 임시등록 완료, 본등록의 비밀번호 또는 Google 연동 대기 | 아직 차단 |
| 관세청 공공데이터포털 | 데이터셋 확인 완료, 포털 로그인 대기 | 아직 차단 |
| WTO | 계정·비밀번호·CAPTCHA가 필요해 미신청 | 아직 차단 |
| Companies House | 별도 계정과 애플리케이션 생성이 필요해 미신청 | 아직 차단 |
| Semantic Scholar | 소속·웹사이트·상세 사용계획·CAPTCHA·수동심사 때문에 미신청 | 키 없이 쓸 수 있는 일부 공개 엔드포인트와 별도 검토 필요 |
| EPO OPS | 회사 주소·전화·회사 대리 권한 확인·CAPTCHA·약관 동의가 필요해 미신청 | 아직 차단 |
| KIPRISPlus | 관리자 승인과 상품별 결제 절차가 있어 미신청 | 아직 차단 |

전체 엄격 검증 결과는 `PASS 59 / BLOCKED_NO_CREDENTIAL 9 / FAIL 0`이다. 새로 발급한 키에 대해서는 건강상태 조회에 그치지 않고 Census, Congress, USDA ERS, OpenAlex의 대표 데이터 도구를 별도로 호출해 모두 통과시켰다.

## 1. 먼저 신청할 최소 세트

전부 발급할 필요는 없다. 비용·승인 부담과 업무 활용도를 고려하면 아래 순서가 적절하다.

| 우선순위 | 신청 대상 | 열리는 MCP·소스 | 국가·기관 | 난도 | 권고 |
|---|---|---|---|---|---|
| 1 | 공공데이터포털 관세청 API | `trade-market` / 관세청 | 대한민국 / 관세청 | 쉬움 | 철강 HS 수출입에 직접 필요하므로 우선 신청 |
| 2 | api.data.gov 공통 키 | `legislation-regulation` / Congress, `environment-industry` / USDA ERS | 미국 / GSA·의회도서관·USDA | 매우 쉬움 | 한 번 발급해 두 소스에 재사용 |
| 3 | FRED 키 | `macro-finance` / FRED | 미국 / 세인트루이스 연은 | 쉬움 | 거시·금리·산업 선행지표에 활용도가 높음 |
| 4 | Census 키 | `trade-market` / U.S. Census Trade | 미국 / 상무부 센서스국 | 매우 쉬움 | 미국 HS 양자무역 분석에 필요 |
| 5 | OpenAlex 키 | `patent-tech` / OpenAlex | 미국 / OurResearch | 매우 쉬움 | 2026년 2월부터 모든 API 요청에 키 필요 |
| 6 | Companies House 키 | `company-disclosure` / Companies House | 영국 / Companies House | 쉬움 | 영국 경쟁사·법인 조사 수요가 있을 때 신청 |

WTO와 일본 e-Stat은 해당 국가·분야 분석 수요가 있을 때 추가한다. Semantic Scholar, EPO OPS, KIPRISPlus는 승인·쿼터·비용 부담이 있으므로 실제 사용 요구가 확인된 뒤 신청한다.

## 2. 신청이 필요 없는 항목

| MCP·소스 | 국가·기관 | 해야 할 일 |
|---|---|---|
| `company-disclosure` / OpenDART | 대한민국 / 금융감독원 | 기존 `DART_API_KEY`가 이미 MyHarness 사용자 설정에 등록되어 있어 추가 신청 불필요 |
| `company-disclosure` / SEC EDGAR 조회 API | 미국 / SEC | API 키·SEC 계정 신청 불필요. 실제 조직명과 모니터링되는 이메일을 `SEC_USER_AGENT`로 설정해야 함 |
| Eurostat, ECB, BIS, NY Fed, OECD, Federal Register, 유럽의회, EUR-Lex, UK Bills, legislation.gov.uk, Crossref, EPA ECHO, ADB | 각 기관 | 인증 없이 실제 API 검증 완료. 추가 신청 불필요 |
| 기존 KOSIS, Comtrade, ECOS, EIA MCP | 대한민국·국제기구·미국 | 사용자가 이미 키를 보유하고 있으므로 새 그룹에 중복 등록하지 않음 |

SEC의 `SEC_USER_AGENT`에는 임의 문자열을 넣으면 안 된다. 예를 들어 `회사명 MyHarness 담당자메일@회사도메인`처럼 실제 연락 가능한 정보를 사용한다. SEC의 회사별 submissions·XBRL 조회 API는 인증키가 없지만, 자동 접근에는 식별 가능한 User-Agent와 공정 접근 정책 준수가 필요하다.

## 3. 소스별 신청 절차

### 3.1 관세청 수출입무역통계 — 대한민국

- 대상 MCP: `trade-market`
- 공식 신청 페이지: [관세청 품목별 국가별 수출입실적](https://www.data.go.kr/data/15100475/openapi.do)
- 설정 이름: `KCS_TRADE_API_KEY` 또는 `DATA_GO_KR_API_KEY`
- 한국 사용자 난도: 쉬움
- 비용·승인: 무료. 개발계정 자동승인, 운영계정은 심의승인

신청 순서:

1. 공공데이터포털에 개인 또는 기업회원으로 로그인한다.
2. 위 데이터셋에서 `활용신청`을 누른다.
3. 개인 서비스키 또는 프로젝트 서비스키를 선택하고 활용 목적을 입력한다.
4. 개발계정 자동승인 후 마이페이지의 인증키를 복사한다.
5. 운영 트래픽이 필요할 때만 활용사례를 등록하고 운영계정·트래픽 증설 심의를 신청한다.

이 데이터셋은 개발계정 기준 일 10,000건이며, API 응답은 XML이다. MyHarness는 XML을 구조화 데이터로 직접 파싱하므로 OCR은 사용하지 않는다. 포털에서 제공하는 Encoding·Decoding 키 중 어느 쪽을 전달해도 현재 어댑터에서 정규화한다.

### 3.2 api.data.gov 공통 키 — 미국

- 대상 MCP: `legislation-regulation`의 Congress.gov, `environment-industry`의 USDA ERS
- 공식 신청 페이지: [api.data.gov API Key Sign Up](https://api.data.gov/signup/)
- 설정 이름: `DATA_GOV_API_KEY`
- 한국 사용자 난도: 매우 쉬움
- 비용·승인: 무료, 이름과 유효 이메일로 신청 후 이메일 발급

신청 순서:

1. 신청 페이지에서 이름과 이메일을 입력한다.
2. 이메일로 전달된 API 키를 확인한다.
3. 하나의 키를 `DATA_GOV_API_KEY`로 등록한다.
4. 이 키를 Congress와 USDA ERS 양쪽에 공통으로 사용한다.

`DEMO_KEY`는 기본 한도가 매우 낮아 운영에 사용하지 않는다. 자체 키의 일반 기본 한도는 참여 서비스별 차이가 있을 수 있으나 api.data.gov 기본값은 시간당 1,000회다. Congress 전용 신청 화면을 선호하면 [Congress.gov API Sign Up](https://api.congress.gov/sign-up/)을 사용해도 결과적으로 api.data.gov 키가 발급된다.

### 3.3 FRED — 미국

- 대상 MCP: `macro-finance`
- 공식 안내: [FRED API Keys](https://fred.stlouisfed.org/docs/api/fred/v2/api_key.html)
- 설정 이름: `FRED_API_KEY`
- 한국 사용자 난도: 쉬움
- 비용·승인: 무료 계정 필요

신청 순서:

1. FRED 계정을 생성하고 로그인한다.
2. API Keys 화면에서 MyHarness용 키를 새로 요청한다.
3. 애플리케이션 이름은 `MyHarness macro-finance`처럼 용도를 구분해 입력한다.
4. 발급된 키를 `FRED_API_KEY`로 등록한다.

FRED는 애플리케이션마다 별도 키를 발급하라고 안내하므로 다른 프로그램의 키를 돌려쓰기보다 MyHarness용 키를 따로 만드는 것이 좋다.

### 3.4 U.S. Census International Trade — 미국

- 대상 MCP: `trade-market`
- 공식 신청 페이지: [Request a U.S. Census Data API Key](https://api.census.gov/data/key_signup.html)
- 설정 이름: `CENSUS_API_KEY`
- 한국 사용자 난도: 매우 쉬움
- 비용·승인: 무료

신청 순서:

1. Organization Name에 회사명 또는 소속명을 영문으로 입력한다.
2. 실제 수신 가능한 이메일을 입력하고 이용약관에 동의한다.
3. 이메일로 도착한 키와 활성화 안내를 확인한다.
4. 발급 키를 `CENSUS_API_KEY`로 등록한다.

api.data.gov 키와 Census 키는 서로 다른 체계이므로 별도로 발급해야 한다.

### 3.5 OpenAlex — 미국

- 대상 MCP: `patent-tech`
- 공식 키 페이지: [OpenAlex API Settings](https://openalex.org/settings/api)
- 공식 안내: [OpenAlex Authentication & Pricing](https://developers.openalex.org/guides/authentication)
- 설정 이름: `OPENALEX_API_KEY`
- 한국 사용자 난도: 매우 쉬움
- 비용·승인: 계정·키 무료. 현재 무료 사용분은 일일 사용 크레딧 방식

신청 순서:

1. OpenAlex 계정을 만든다.
2. 로그인 후 API Settings로 이동한다.
3. 표시된 API 키를 복사해 `OPENALEX_API_KEY`로 등록한다.

OpenAlex는 2026년 2월 13일부터 모든 API 요청에 키를 요구한다. MyHarness MCP는 논문·주제 메타데이터만 사용하고 유료 PDF 다운로드 기능은 사용하지 않는다.

### 3.6 Companies House — 영국

- 대상 MCP: `company-disclosure`
- 공식 시작 안내: [Get started with the Companies House API](https://developer.company-information.service.gov.uk/get-started)
- 앱·키 생성 안내: [How to create an application](https://developer.company-information.service.gov.uk/how-to-create-an-application)
- 설정 이름: `COMPANIES_HOUSE_API_KEY`
- 한국 사용자 난도: 쉬움
- 비용·승인: 일반 공개 회사조회용 API 키는 무료

신청 순서:

1. Companies House 사용자 계정을 등록하고 로그인한다.
2. `Create an application`에서 애플리케이션 이름과 설명을 입력한다.
3. 실제 회사정보 조회를 위해 live application을 선택한다.
4. 애플리케이션 화면에서 `Create new key`를 누른다.
5. client type은 일반 공개 GET 조회에 사용하는 `API key`를 선택한다. Stream key나 OAuth web client는 선택하지 않는다.
6. 생성된 키를 `COMPANIES_HOUSE_API_KEY`로 등록한다.

한국 법인·주소를 요구하는 회사설립 절차가 아니라 개발자 계정과 API 애플리케이션 생성 절차다. MyHarness는 공개 회사검색·프로필·임원·공시이력 조회만 사용한다.

### 3.7 WTO Timeseries API — 국제기구

- 대상 MCP: `trade-market`
- 공식 포털: [WTO API Developer Portal](https://apiportal.wto.org/)
- 상품 페이지: [WTO API Products](https://apiportal.wto.org/products)
- 설정 이름: `WTO_API_KEY`
- 한국 사용자 난도: 보통
- 비용·승인: Standard 구독 무료

신청 순서:

1. WTO Developer Portal에서 계정을 생성하고 이메일을 확인한다.
2. 로그인 후 Products에서 `Standard` 상품을 선택한다.
3. 무료 구독을 신청하고 발급된 subscription key를 확인한다.
4. primary key를 `WTO_API_KEY`로 등록한다.

Standard 상품은 일반 호출 10회/초·10,000회/시간이지만, 시계열 data/data_count는 1회/초 제한이 있으므로 대량 병렬 호출에는 적합하지 않다.

### 3.8 일본 e-Stat — 일본

- 대상 MCP: `macro-finance`
- 공식 영문 가이드: [e-Stat API User Guide](https://www.e-stat.go.jp/api/en/api-info/api-guide)
- 설정 이름: `ESTAT_JP_APP_ID`
- 한국 사용자 난도: 보통
- 비용·승인: 무료, e-Stat 계정 필요

신청 순서:

1. e-Stat 사용자 계정을 등록하고 로그인한다.
2. My Page의 `API (Issue Application ID)` 메뉴로 이동한다.
3. 애플리케이션 이름·설명·URL을 입력한다. 외부 공개 서비스가 아니면 URL에 `http://localhost/` 같은 로컬 주소를 사용할 수 있다.
4. `Issue`를 눌러 Application ID를 발급한다.
5. 발급값을 `ESTAT_JP_APP_ID`로 등록한다.

공식 FAQ상 한 계정에서 Application ID는 최대 3개다. 키 발급보다 실제 통계표 ID와 차원코드를 찾는 작업이 더 어렵다는 점을 고려해야 한다.

### 3.9 Semantic Scholar — 미국

- 대상 MCP: `patent-tech`
- 공식 신청 페이지: [Semantic Scholar Academic Graph API](https://www.semanticscholar.org/product/api#api-key-form)
- 설정 이름: `SEMANTIC_SCHOLAR_API_KEY`
- 한국 사용자 난도: 보통~높음
- 비용·승인: 신청형 무료 키. 이메일 수령까지 대기·심사가 있을 수 있음

신청 순서:

1. 공식 페이지의 `Request an API Key` 양식을 연다.
2. 이름·이메일·소속·프로젝트 설명·예상 사용량을 사실대로 입력한다.
3. 용도에는 논문 메타데이터·인용관계 검색이며 PDF 재배포는 하지 않는다고 명시한다.
4. 이메일로 키가 도착하면 `SEMANTIC_SCHOLAR_API_KEY`로 등록한다.

초기 인증 키 한도는 공식 안내상 전체 엔드포인트 합계 1 RPS다. 무인증 요청은 공유 한도 때문에 이 환경에서 429가 발생했으므로 키 승인 전에는 사용 불가 상태를 유지한다.

### 3.10 EPO Open Patent Services — 유럽 국제기구

- 대상 MCP: `patent-tech`
- 공식 안내·등록 시작점: [EPO Open Patent Services](https://www.epo.org/en/searching-for-patents/data/web-services/ops)
- 설정 이름: `EPO_OPS_CLIENT_ID`, `EPO_OPS_CLIENT_SECRET`
- 한국 사용자 난도: 보통~높음
- 비용·승인: 등록과 테스트 앱 필요. 무료 허용량 초과 시 청구정보·비용 발생 가능

신청 순서:

1. OPS 페이지에서 `Register`를 눌러 EPO 개발자 계정을 만든다.
2. 로그인 후 테스트 애플리케이션을 정의한다.
3. APIs 메뉴에서 검색·서지 응답을 시험한다.
4. 애플리케이션의 OAuth consumer key와 consumer secret을 확인한다.
5. consumer key를 `EPO_OPS_CLIENT_ID`, consumer secret을 `EPO_OPS_CLIENT_SECRET`에 등록한다.

EPO OPS는 단일 키가 아니라 OAuth 자격증명 두 개가 필요하다. 무료 임계치를 넘는 다운로드는 비용이 발생할 수 있으므로, MyHarness에서는 PDF·이미지·전문 다운로드 없이 서지·패밀리 XML만 사용한다.

### 3.11 KIPRISPlus — 대한민국

- 대상 MCP: `patent-tech`
- 공식 이용절차: [KIPRISPlus 이용 절차](https://plus.kipris.or.kr/portal/main/contents.do?menuNo=210104)
- 필요한 상품: [특허·실용 공개·등록공보](https://plus.kipris.or.kr/portal/popup/service/DBII_000000000000001/view.do)
- 설정 이름: `KIPRIS_API_KEY` 또는 `KIPRIS_PLUS_API_KEY`
- 한국 사용자 난도: 가입은 쉬우나 상품 승인·비용 때문에 운영 난도 높음
- 비용·승인: 상품 조건에 따라 관리자 승인과 수수료 결제가 필요할 수 있음

신청 순서:

1. 개인 또는 단체회원으로 가입한다. 법인계좌·법인카드를 쓰려면 단체회원이 적합하다.
2. Open API 메뉴에서 `특허·실용 공개·등록공보` 상품을 선택한다.
3. 장바구니에서 활용 서비스명·활용 목적·이용 조건을 입력해 구매 신청한다.
4. 관리자 승인 여부와 견적을 마이페이지에서 확인한다.
5. 유료 조건이면 내부 예산 승인을 받은 뒤 결제한다.
6. 마이페이지의 `APIKEY관리`에서 인증키를 확인해 등록한다.

현재 어댑터가 필요한 것은 `getWordSearch`와 `getBibliographyDetailInfoSearch`를 포함한 검색·서지 API다. 도면·전문 PDF·Bulk 상품은 구매할 필요가 없다. 단순 무료 키로 가정하면 안 되므로 실제 견적과 이용조건을 확인하기 전까지 보류가 안전하다.

## 4. 발급 후 전달할 값

키를 발급받은 뒤에는 저장소나 `.mcp/*.json`에 직접 적지 말고 MyHarness 사용자 MCP 설정에 넣는다. 전달해야 할 이름은 다음과 같다.

```text
SEC_USER_AGENT=
COMPANIES_HOUSE_API_KEY=
KCS_TRADE_API_KEY=
CENSUS_API_KEY=
WTO_API_KEY=
FRED_API_KEY=
ESTAT_JP_APP_ID=
DATA_GOV_API_KEY=
KIPRIS_API_KEY=
EPO_OPS_CLIENT_ID=
EPO_OPS_CLIENT_SECRET=
OPENALEX_API_KEY=
SEMANTIC_SCHOLAR_API_KEY=
```

`DATA_GOV_API_KEY`는 Congress와 USDA ERS가 함께 사용하므로 두 번 발급할 필요가 없다. `SEC_USER_AGENT`는 비밀키가 아니지만 실제 연락처이므로 공개 저장소에는 넣지 않는다.

## 5. 발급 후 완료 판정

키를 등록했다고 바로 완료 처리하지 않는다. 다음 순서로 검증한다.

1. `python scripts/verify_official_data_mcps.py`로 실제 7개 stdio MCP를 기동한다.
2. 해당 소스의 상태가 `BLOCKED_NO_CREDENTIAL`에서 `PASS`로 바뀌는지 확인한다.
3. 카탈로그·검색·상세조회처럼 서로 다른 도구를 실제 공식 API에 호출한다.
4. 응답에 키가 노출되지 않는지, 기간·페이지 제한이 적용되는지 확인한다.
5. 검증 결과가 모두 통과한 소스만 운영 가능으로 변경한다.

현재 자격증명 미보유 소스는 모의 계약 테스트까지만 통과한 상태다. 키 발급 후 위 실검증을 거치기 전에는 “구현 완료”가 아니라 “어댑터 준비 완료, 인증 미검증”으로 보고해야 한다.
