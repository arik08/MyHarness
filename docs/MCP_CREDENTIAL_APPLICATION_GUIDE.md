# MyHarness MCP API 자격증명 발급 안내서

작성 기준: 2026-08-12 20:50 KST

대상: MyHarness 공식 데이터 MCP를 실제 운영하려는 사용자

검증 기준: MCP 연결이나 `health` 응답만이 아니라 실제 검색·상세·수치 데이터 호출

## 0. 결론부터 보기

현재 실검증 결과는 다음과 같다.

- 공식 데이터 검증기: `PASS 60 / BLOCKED_NO_CREDENTIAL 8 / FAIL 0`
- 전체 MCP 함수 검증에서 추가 확인된 차단: NABO `get_nabo` 1개
- 새로 발급하거나 신청해야 하는 자격증명 묶음: **9개**
- API 키 이외의 코드·연결·파싱 실패: **0개**

### 지금 발급받을 목록

| 우선순위 | 기관·데이터 | MyHarness 설정 이름 | 난도 | 비용·승인 | 권고 |
|---:|---|---|---|---|---|
| 1 | 관세청 수출입무역통계 | `KCS_TRADE_API_KEY` 또는 `DATA_GO_KR_API_KEY` | 쉬움 | 무료, 개발계정 자동승인 | 바로 신청 |
| 2 | FRED | `FRED_API_KEY` | 쉬움 | 무료 계정 | 바로 신청 |
| 3 | 국회예산정책처 NABO | `NABO_API_KEY` | 쉬움~보통 | SNS 인증 후 담당자 승인 | 바로 신청 |
| 4 | Companies House | `COMPANIES_HOUSE_API_KEY` | 쉬움 | 계정·앱 생성 | 영국 기업 분석 시 필수 |
| 5 | WTO Timeseries | `WTO_API_KEY` | 보통 | Standard 무료 구독 | 국제 무역·관세 분석 시 권장 |
| 6 | 일본 e-Stat | `ESTAT_JP_APP_ID` | 보통 | 무료, 계정 필요 | 일본 통계 수요가 있으면 신청 |
| 7 | Semantic Scholar | `SEMANTIC_SCHOLAR_API_KEY` | 보통 | 신청·이메일 발급, 심사 가능 | 논문 분석 안정성에 권장 |
| 8 | EPO OPS | `EPO_OPS_CLIENT_ID`, `EPO_OPS_CLIENT_SECRET` | 보통~높음 | 주 4GB까지 무료, 초과 유료 | 특허 분석 수요 확인 후 신청 |
| 9 | KIPRISPlus | `KIPRIS_API_KEY` 또는 `KIPRIS_PLUS_API_KEY` | 높음 | 상품 승인, 무료량 초과 시 유료 | 가장 나중에 신청 |

### 이미 정상이라 새로 받을 필요가 없는 항목

2026-08-12 실호출에서 다음 자격증명 경로는 이미 정상 동작했다. 키 값을 다시 만들거나 이 문서에 적을 필요가 없다.

- OpenDART: `DART_API_KEY` 또는 `OPENDART_API_KEY`
- SEC EDGAR: `SEC_USER_AGENT` — API 키가 아니라 실제 조직명·연락 이메일 식별자
- U.S. Census: `CENSUS_API_KEY`
- Congress.gov·USDA ERS 공통: `DATA_GOV_API_KEY`
- OpenAlex: `OPENALEX_API_KEY`
- 기존 Comtrade·ECOS·EIA·KOSIS·열린국회정보 자격증명

Eurostat, ECB, BIS, NY Fed, OECD, Federal Register, 유럽의회, EUR-Lex, UK Bills, legislation.gov.uk, Crossref, EPA ECHO, ADB, World Bank는 현재 MyHarness 사용 범위에서 별도 키 없이 통과했다.

## 1. 신청 전에 알아둘 보안 원칙

### 저장소 파일에 키를 넣지 않는다

다음 위치에는 실제 값을 적지 않는다.

- `.skills/mcp/*/mcp.json`
- `docs/*.md`
- 테스트 파일과 스크린샷
- Git에 추적되는 설정 파일

현재 이 체크아웃의 `myharness.local.env`는 Git 추적 대상이다. 따라서 **현 상태에서는 여기에 비밀키를 넣지 않는다.** 대신 Git에서 무시되는 로컬 파일 `API_KEY.env`를 사용할 수 있다. `run_myharness_web.bat`와 `run_myharness_web_dev.bat`가 이 파일을 `myharness.local.env` 다음에 읽어 MCP 프로세스에 전달한다. 파일은 저장소에 커밋하지 않는다.

### 키를 화면이나 명령 기록에 노출하지 않고 저장하기

PowerShell에서 다음 함수를 한 번 정의한다. 입력값은 화면에 표시되지 않는다.

```powershell
function Set-MyHarnessUserSecret {
    param([Parameter(Mandatory = $true)][string]$Name)
    $secure = Read-Host "$Name 값을 붙여넣으세요" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        [Environment]::SetEnvironmentVariable($Name, $plain, "User")
    }
    finally {
        if ($plain) { $plain = $null }
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    }
}
```

발급받은 항목만 다음처럼 등록한다.

```powershell
Set-MyHarnessUserSecret KCS_TRADE_API_KEY
Set-MyHarnessUserSecret FRED_API_KEY
Set-MyHarnessUserSecret NABO_API_KEY
```

EPO는 두 값을 각각 등록한다.

```powershell
Set-MyHarnessUserSecret EPO_OPS_CLIENT_ID
Set-MyHarnessUserSecret EPO_OPS_CLIENT_SECRET
```

등록 후에는 MyHarness를 완전히 종료하고 다시 실행해야 새 환경변수가 반영된다.

### 선택 사항: 로컬 `API_KEY.env` 파일

저장소 루트의 [API_KEY.env](/C:/Users/user/Desktop/Documents/Python/MyHarness/API_KEY.env)에 발급받은 값을 직접 넣을 수 있다. 이 파일은 `.gitignore`에 등록되어 있으며 현재는 빈 템플릿이다.

전체 변수 이름만 확인하려면 추적 가능한 [.env.example](/C:/Users/user/Desktop/Documents/Python/MyHarness/.env.example)을 참고한다. `.env.example`은 예시 파일이므로 런처가 읽지 않는다.

```text
KCS_TRADE_API_KEY=새로_발급받은_관세청_일반인증키
```

URL 인코딩된 키를 그대로 한 줄에 넣고, 키 값 앞뒤에 따옴표를 붙이지 않는다. 기존 채팅에 노출된 키는 재사용하지 말고 포털에서 재발급한다.

### 값은 출력하지 않고 등록 여부만 확인하기

```powershell
$names = @(
  "COMPANIES_HOUSE_API_KEY", "KCS_TRADE_API_KEY", "WTO_API_KEY",
  "FRED_API_KEY", "ESTAT_JP_APP_ID", "NABO_API_KEY",
  "SEMANTIC_SCHOLAR_API_KEY", "EPO_OPS_CLIENT_ID",
  "EPO_OPS_CLIENT_SECRET", "KIPRIS_API_KEY"
)
$names | ForEach-Object {
    $configured = -not [string]::IsNullOrWhiteSpace(
        [Environment]::GetEnvironmentVariable($_, "User")
    )
    [PSCustomObject]@{ Name = $_; Configured = $configured }
}
```

## 2. 공통 신청서 작성 예시

기관 신청서에서 서비스명·URL·용도·호출량을 물으면 다음 내용을 실제 상황에 맞게 수정해 사용한다. 회사 내부 사실을 임의로 추가하지 않는다.

### 한국어 용도 문구

> MyHarness는 사무계 업무용 내부 AI 에이전트 시스템입니다. 공식 공개 API에서 기업 공시, 무역, 거시경제, 입법, 특허·학술 메타데이터를 소량 조회해 내부 조사와 보고서 작성에 활용합니다. 원문 데이터나 API 키를 재판매·공개 배포하지 않으며, 결과에는 출처를 표시합니다. 대량 수집이나 PDF 전문 다운로드는 수행하지 않고 페이지·기간·건수를 제한합니다.

### 영문 용도 문구

> MyHarness is an internal AI agent for business research and report preparation. It retrieves small, bounded sets of official public metadata and statistics for company, trade, macroeconomic, legislative, patent, and scholarly analysis. We do not resell or publicly redistribute raw API data or credentials. Requests are rate-limited and scoped by date, page size, country, and identifier. We do not perform bulk full-text or image downloads.

### 공통 입력 예시

| 항목 | 권장 입력 |
|---|---|
| Application name | `MyHarness official-data connector` |
| Website / URL | 외부 공개 서비스가 없으면 기관이 허용하는 경우 `http://localhost/` |
| Intended use | Internal research and report preparation |
| Expected traffic | 개발·검증 단계: 일 수십~수백 회, 실제 예상치를 보수적으로 입력 |
| Data retention | 분석 결과와 출처 링크만 보관, 원시 대량 덤프·키는 산출물에 저장하지 않음 |
| Contact | 실제 수신 가능한 담당자 이메일 |

## 3. 무료·우선 발급 대상

### 3.1 관세청 품목별 국가별 수출입실적

- 대상 MCP: `trade-market`, source `customs_kr`
- 설정 이름: `KCS_TRADE_API_KEY` 권장, 대체로 `DATA_GO_KR_API_KEY`
- 공식 신청: [공공데이터포털 관세청 품목별 국가별 수출입실적](https://www.data.go.kr/data/15100475/openapi.do)
- 비용: 무료
- 승인: 개발계정 자동승인, 운영계정 심의승인
- 공식 표시 한도: 개발계정 10,000건
- 응답 형식: XML — MyHarness가 구조화 파싱하므로 OCR 불필요

신청 절차:

1. 공공데이터포털에 개인 또는 기업회원으로 로그인한다.
2. 위 데이터셋의 `활용신청`을 누른다.
3. 활용 목적에 내부 철강·원료 수출입 조사라고 사실대로 적는다.
4. 개발계정 승인이 끝나면 마이페이지에서 서비스키를 확인한다.
5. 포털이 Encoding/Decoding 키를 모두 보여주면 우선 **일반 인증키(Encoding)** 를 보관한다. MyHarness는 전달값을 정규화하지만 한 값만 관리하는 편이 안전하다.
6. `KCS_TRADE_API_KEY`로 등록한다.

주의사항:

- API 기간은 공식 명세상 1년 이내로 제한한다.
- 운영계정·트래픽 증설은 실제 호출량이 개발한도를 넘을 때만 신청한다.
- `DATA_GOV_API_KEY`는 미국 api.data.gov 키이므로 한국 공공데이터포털의 `DATA_GO_KR_API_KEY`와 이름이 다르다.

발급 후 검증 예시: 한국의 특정 HS 품목, 상대국, 1개월을 지정해 실제 금액·중량 행이 반환되는지 확인한다.

### 3.2 FRED

- 대상 MCP: `macro-finance`, source `fred`
- 설정 이름: `FRED_API_KEY`
- 공식 안내: [FRED API Keys](https://fred.stlouisfed.org/docs/api/fred/v2/api_key.html)
- 비용: 무료
- 조건: FRED 계정 로그인 필요

신청 절차:

1. FRED 계정을 만들고 로그인한다.
2. API Keys 화면에서 새 키를 요청한다.
3. 애플리케이션 이름을 `MyHarness macro-finance`로 구분한다.
4. 발급된 키를 `FRED_API_KEY`로 등록한다.

FRED는 애플리케이션별 별도 키를 권고한다. 다른 프로그램 키를 복사해 쓰기보다 MyHarness 전용 키를 만든다.

발급 후 검증 예시: `GDP`, `CPIAUCSL`, `DFF` 중 하나를 검색하고 최근 관측치의 날짜·수치·단위가 모두 나오는지 확인한다.

### 3.3 국회예산정책처 NABO

- 대상 MCP: `national-assembly`, tool `get_nabo`
- 설정 이름: `NABO_API_KEY`
- 공식 이용안내: [NABO Open API 이용안내](https://www.nabo.go.kr/ko/api/apiUseInfo.do?key=2509230003)
- 공식 신청·관리: [NABO 인증키 신청·관리](https://www.nabo.go.kr/ko/api/apply.do?key=2509230004)
- 승인: SNS 인증 → 신청 → 담당자 승인 → 키 발급
- 문의: `iamnabo@nabo.go.kr`, 02-2070-3114

신청 절차:

1. 신청 페이지에서 SNS 인증으로 신청자를 확인한다.
2. 서비스 용도에 NABO 보고서·정기간행물 메타데이터를 내부 정책·예산 조사에 활용한다고 적는다.
3. 담당자 승인을 기다린다.
4. 발급 상태가 승인인지 확인하고 `NABO_API_KEY`로 등록한다.

공식 API는 `INVALID_KEY`, `NOT_APPROVED`, `NOT_YET_VALID`, `EXPIRED`를 구분한다. 키 문자열이 존재하더라도 승인 전·사용 시작 전·만료 상태면 정상 동작하지 않는다.

발급 후 검증 예시: `get_nabo(type="report", keyword="예산", page_size=5)`에서 제목·게시일·상세 URL이 실제로 반환되는지 확인한다.

### 3.4 Companies House

- 대상 MCP: `company-disclosure`, source `companies_house`
- 설정 이름: `COMPANIES_HOUSE_API_KEY`
- 공식 시작 안내: [Get started](https://developer.company-information.service.gov.uk/get-started)
- 공식 앱 생성: [How to create an application](https://developer.company-information.service.gov.uk/how-to-create-an-application)

신청 절차:

1. Companies House 사용자 계정을 만들고 로그인한다.
2. `Create an application`에서 이름과 설명을 입력한다.
3. 실제 공개 회사정보 조회에는 live application을 선택한다. 먼저 샌드박스만 시험하려면 test application을 별도로 만든다.
4. 애플리케이션 화면에서 `Create new key`를 누른다.
5. client type은 **API key**를 선택한다. MyHarness 공개 GET 조회에는 Stream key나 OAuth web client가 필요하지 않다.
6. 발급값을 `COMPANIES_HOUSE_API_KEY`로 등록한다.

이 절차는 영국 회사를 설립하는 과정이 아니다. 개발자 계정과 API application을 만드는 과정이다.

발급 후 검증 예시: 알려진 영국 회사명을 검색한 뒤 반환된 company number로 프로필·임원·filing history를 연속 조회한다.

### 3.5 WTO Timeseries API

- 대상 MCP: `trade-market`, source `wto`
- 설정 이름: `WTO_API_KEY`
- 공식 포털: [WTO API Developer Portal](https://apiportal.wto.org/)
- 공식 상품: [WTO API Products](https://apiportal.wto.org/products)
- Standard 구독: 무료
- 공식 한도: 일반 10회/초·10,000회/시간, time-series `data`·`data_count`는 1회/초

신청 절차:

1. WTO Developer Portal에 가입하고 이메일을 확인한다.
2. 로그인 후 Products에서 Standard를 구독한다.
3. subscription의 primary key를 확인한다.
4. `WTO_API_KEY`로 등록한다.

발급 후 검증 예시: 한국·연도·지표를 모두 지정해 시계열 값과 단위가 반환되는지 확인한다. 1초당 1회 제한 경로는 병렬 호출하지 않는다.

### 3.6 일본 e-Stat

- 대상 MCP: `macro-finance`, source `estat_jp`
- 설정 이름: `ESTAT_JP_APP_ID`
- 공식 가이드: [e-Stat API User Guide](https://www.e-stat.go.jp/api/api/api/index.php/en/api-info/api-guide)
- 공식 FAQ: [e-Stat API FAQ](https://www.e-stat.go.jp/api/en/api-dev/faq)
- 비용: 무료
- 제한: 계정당 Application ID 최대 3개

신청 절차:

1. e-Stat 계정을 등록하고 로그인한다.
2. My Page의 `API (Issue Application ID)`로 이동한다.
3. 이름·URL·설명을 입력한다. 공개 서비스가 아니면 공식 가이드가 허용하는 `http://localhost/`를 URL로 쓸 수 있다.
4. `Issue`를 눌러 Application ID를 발급한다.
5. `ESTAT_JP_APP_ID`로 등록한다.

발급 후 검증 예시: 먼저 통계표 검색으로 실제 `statsDataId`를 얻고, 그 ID로 관측값을 조회한다. 임의 통계표 ID를 만들지 않는다.

## 4. 신청·심사형 대상

### 4.1 Semantic Scholar

- 대상 MCP: `patent-tech`, source `semantic_scholar`
- 설정 이름: `SEMANTIC_SCHOLAR_API_KEY`
- 공식 신청: [Semantic Scholar Academic Graph API](https://www.semanticscholar.org/product/api)
- 발급: 신청 후 이메일 수령
- 초기 인증 한도: 공식 안내상 전체 엔드포인트 합계 1 RPS

공식적으로 다수 엔드포인트는 무인증 접근이 가능하지만 공유 무인증 트래픽은 혼잡 시 추가 제한될 수 있다. MyHarness는 공유 출구 IP에서의 429와 불안정성을 피하기 위해 운영상 키를 필수로 취급한다.

신청서 권장 내용:

- 용도: scholarly metadata, citations, authors and paper identifiers for internal research
- 저장: 제목·저자·DOI·인용 메타데이터와 출처 링크
- 제외: PDF 재배포, 대량 원문 수집, 키 공유
- 호출량: 1 RPS 이하, batch endpoint 우선

발급 후 검증 예시: 논문 검색으로 실제 paper ID를 얻고, 그 ID로 상세 메타데이터와 인용 수를 조회한다.

### 4.2 EPO Open Patent Services

- 대상 MCP: `patent-tech`, source `epo_ops`
- 설정 이름: `EPO_OPS_CLIENT_ID`, `EPO_OPS_CLIENT_SECRET`
- 공식 안내·등록: [EPO Open Patent Services](https://www.epo.org/en/searching-for-patents/data/web-services/ops)
- 인증: OAuth consumer key + consumer secret
- 무료 범위: 주 4GB까지
- 초과 요금: 연 EUR 2,800 구독 — 신청 시점의 최신 가격을 다시 확인

신청 절차:

1. EPO OPS에 등록해 계정을 만든다.
2. 로그인 후 test app을 정의한다.
3. APIs 메뉴에서 테스트한다.
4. 실제 애플리케이션을 정의하고 OAuth 자격증명을 발급받는다.
5. consumer key를 `EPO_OPS_CLIENT_ID`, consumer secret을 `EPO_OPS_CLIENT_SECRET`에 등록한다.

MyHarness 용도에는 검색·서지·패밀리 XML이면 충분하다. 이미지·전문 대량 다운로드나 4GB/주 초과 유료 구독은 먼저 신청하지 않는다. OPS는 대량 데이터 백엔드용 서비스가 아니며 문서 조회도 공식 안내상 범위를 제한해야 한다.

발급 후 검증 예시: 특허 검색 결과의 실제 publication number를 사용해 서지·패밀리 상세를 조회한다.

### 4.3 KIPRISPlus

- 대상 MCP: `patent-tech`, source `kipris`
- 설정 이름: `KIPRIS_API_KEY` 권장, 대체로 `KIPRIS_PLUS_API_KEY`
- 공식 절차: [KIPRISPlus 가입 및 신청 안내](https://plus.kipris.or.kr/portal/main/contents.do?menuNo=210104)
- 공식 수수료: [KIPRISPlus 서비스 수수료](https://plus.kipris.or.kr/portal/use/paymentMmg.do?menuNo=210112)
- 공식 개발자료: [KIPRISPlus Open API 개발 가이드](https://plus.kipris.or.kr/portal/bbs/view.do?bbsId=B0000001&nttId=1060)

2026-08-12 공식 수수료 페이지 기준:

- 월 1,000회까지 무료
- 유료 이용 시 일 5,320원, 365일 기준 연 1,941,800원(VAT 포함)
- Open API 상품 2개 이하 신청 시 50% 할인
- 개인·중소·중견기업·공공기관·비영리 단체는 추가 50% 할인 가능

가격·할인 조건은 변경될 수 있으므로 결제 직전에 공식 장바구니와 견적을 다시 확인한다.

신청 절차:

1. 개인 또는 단체회원으로 가입한다. 법인계좌·법인카드를 쓰면 단체회원이 필요하다.
2. Open API 메뉴에서 특허·실용 공개·등록공보의 검색·서지 상품을 찾는다.
3. 장바구니에서 이용 조건과 활용 목적을 입력한다.
4. 관리자 승인을 기다린다.
5. 무료 월 1,000회 범위로 충분한지 먼저 판단한다.
6. 유료가 필요하면 내부 예산 승인 후 결제한다.
7. 마이페이지 `APIKEY관리`에서 키를 확인해 등록한다.

MyHarness에는 검색과 서지 상세가 필요하다. 도면, 전문 PDF, Bulk Data 상품은 현재 목적에 필요하지 않으므로 함께 구매하지 않는다.

## 5. 발급 후 검증 절차

키를 등록했다는 사실만으로 완료 처리하지 않는다.

### 5.1 앱 재시작

Windows 사용자 환경변수를 새로 등록한 후 기존 MyHarness 프로세스를 종료하고 런처로 다시 시작한다.

### 5.2 전체 공식 데이터 검증

저장소 루트에서 실행한다.

```powershell
python scripts/verify_official_data_mcps.py --root .
```

현재 기준선:

```text
SUMMARY pass=60 blocked_no_credential=8 fail=0
```

새 키가 정상이라면 해당 source의 `BLOCKED_NO_CREDENTIAL`이 줄고 `PASS`가 증가해야 한다. 총합만 보지 말고 해당 `health:<mcp>:<source>` 행을 확인한다.

NABO는 현재 위 검증기 집계에 포함되지 않으므로 `national-assembly`의 `get_nabo`를 별도로 실제 호출한다.

### 5.3 완료 판정

각 자격증명은 다음을 모두 만족해야 완료다.

1. MCP stdio 프로세스가 시작된다.
2. 해당 source health가 `configured=true`, 실제 endpoint `ok=true`다.
3. 검색 결과가 비어 있지 않다.
4. 검색에서 받은 실제 ID로 상세 조회가 된다.
5. 숫자·날짜·단위·제목 등 도메인 값이 요청과 일치한다.
6. 키 값이 로그·오류·산출물에 노출되지 않는다.
7. 첫 호출부터 성공하며 재시도에서만 우연히 성공한 상태가 아니다.

### 5.4 오류별 판단

| 증상 | 의미 | 조치 |
|---|---|---|
| `BLOCKED_NO_CREDENTIAL` | 환경변수가 없거나 빈 값 | 이름과 사용자 환경변수 등록 여부 확인 후 재시작 |
| 401 / `INVALID_KEY` | 키 오타·잘못된 키 종류 | 복사한 키와 환경변수 이름 확인 |
| 403 / `NOT_APPROVED` | 신청 승인 전이거나 상품 권한 없음 | 포털 승인 상태·구독 상품 확인 |
| `NOT_YET_VALID` | 사용 시작일 전 | 승인된 사용 시작일 확인 |
| `EXPIRED` | 만료 | 재발급·갱신 |
| 429 | 호출 한도 초과 | 재시도 폭주 금지, source 한도에 맞춰 속도 제한 |
| 200이지만 0건 | 자격증명 성공일 수 있음 | 현실적인 조건·카탈로그로 한 번 대조하고 원 조건 0건은 그대로 보고 |

## 6. 추천 신청 순서

한 번에 아홉 곳을 모두 신청할 필요는 없다.

### 1차: 당일 처리 가능성이 높은 무료 키

1. 관세청 공공데이터포털
2. FRED
3. Companies House
4. WTO Standard
5. e-Stat

### 2차: 승인 대기 가능

6. NABO
7. Semantic Scholar

### 3차: 비용·계약 판단 필요

8. EPO OPS — 무료 4GB/주 범위만 우선
9. KIPRISPlus — 월 1,000회 무료 범위와 필요한 상품을 확인한 뒤 신청

## 7. 발급 완료 체크리스트

```text
[ ] KCS_TRADE_API_KEY
[ ] FRED_API_KEY
[ ] NABO_API_KEY
[ ] COMPANIES_HOUSE_API_KEY
[ ] WTO_API_KEY
[ ] ESTAT_JP_APP_ID
[ ] SEMANTIC_SCHOLAR_API_KEY
[ ] EPO_OPS_CLIENT_ID
[ ] EPO_OPS_CLIENT_SECRET
[ ] KIPRIS_API_KEY
```

키를 전달하거나 검증을 요청할 때는 채팅·문서에 값을 붙이지 않는다. 사용자 환경변수에 직접 등록한 뒤 “어떤 이름을 등록했는지”만 알려주면 MyHarness에서 값 노출 없이 실호출 검증할 수 있다.
