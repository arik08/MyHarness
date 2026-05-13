---
name: legal-intake-router
description: 법무/컴플라이언스 요청을 분류하고 적절한 Claude for Legal Lite 스킬로 라우팅합니다. 계약, 개인정보, AI 거버넌스, 제품/마케팅, 고용, 분쟁, IP/OSS 중 어떤 검토가 필요한지 모호할 때 사용합니다.
---

# Legal Lite Intake Router

## 목적

사용자의 법무/컴플라이언스 요청을 빠르게 분류하고, 처리 범위와 필요한 입력을 정합니다.

## 공통 전제

- 모든 산출물은 변호사 또는 권한 있는 전문가 검토용 초안입니다.
- 법률 자문, 최종 법률 결론, 최신 법령/판례 확인을 대신하지 않습니다.
- 사용자가 제공하지 않은 사실, 관할, 계약 금액, 상대방 지위, 발송 대상은 추정하지 않습니다.
- 최신 법령/판례나 유료 DB 확인이 필요한 항목은 `[법무 확인 필요]`로 표시합니다.

## 라우팅

- 계약서, NDA, MSA, SaaS, 약관, 조달/판매 계약: `legal-contract-review`
- DPA, 개인정보 처리, DSAR, PIA/DPIA, privacy policy: `legal-privacy-review`
- AI 기능, AI 사용 사례, 벤더 AI 약관, 모델 학습/로그/데이터 사용: `legal-ai-governance-review`
- 제품 출시, 마케팅 문구, 보증/성능/보안 claim: `legal-product-claims-review`
- 채용, 해고, 징계, 조사, 정책, 근로자 분류: `legal-employment-review`
- 분쟁, demand letter, subpoena, chronology, privilege log, 소송 메모: `legal-dispute-review`
- IP 조항, 오픈소스 라이선스, 상표/저작권/DMCA/C&D 초안: `legal-ip-oss-review`
- 사업부/임원용 요약, 상대방 전달용 sanitized summary: `legal-business-summary`

## 입력 확인

요청이 불명확하면 한 번에 필요한 최소 질문만 합니다.

- 무엇을 검토하나요?
- 어느 관할/국가/주가 관련되나요?
- 사용자는 어느 쪽인가요?
- 산출물을 누구에게 보여줄 예정인가요?
- 원문 문서나 발췌문이 있나요?

## 출력

짧게 라우팅 결과를 제시합니다.

```md
## 분류
- 업무 유형:
- 추천 스킬:
- 처리 가능한 범위:
- 추가로 필요한 입력:
- 법무 확인 필요 항목:
```
