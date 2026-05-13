---
name: legal-ip-oss-review
description: IP 조항, 오픈소스 라이선스 목록, 저작권/상표/DMCA/C&D 초안을 1차 검토합니다. 라이선스 의무, copyleft, attribution, IP 소유/사용권, 침해 주장 대응 메모를 만들 때 사용합니다.
---

# Legal Lite IP And OSS Review

## 목적

사용자가 제공한 IP 조항, OSS 목록, 침해 주장, takedown 요청 등을 바탕으로 1차 검토 메모를 작성합니다.

## 전제

- 상표 clearance, 특허 FTO, 침해/비침해 결론은 내리지 않습니다.
- 라이선스 전문, 사용 방식, 배포 형태가 없으면 결론을 보류합니다.
- 최신 등록/권리 상태나 판례 확인은 `[법무 확인 필요]`로 표시합니다.

## 가능한 작업

- 계약의 IP 소유/라이선스/보증/면책 조항 검토
- OSS 라이선스 의무 triage
- copyleft/notice/source disclosure 리스크 표시
- DMCA takedown/counter-notice 초안 체크
- C&D 수신/발송 전 리스크 메모
- 브랜드/상표 사용 체크리스트

## OSS 체크

- 패키지명, 버전, 라이선스, 사용 위치
- 내부 사용/배포/SaaS/on-prem/mobile/embedded 여부
- 수정 여부와 source 배포 여부
- notice, attribution, license text 포함 여부
- GPL/AGPL/LGPL/MPL/EPL 등 reciprocal 의무 가능성

## 출력 형식

```md
# IP/OSS 검토 초안: [주제]

## 결론
- 리스크 수준:
- 즉시 필요한 조치:
- 법무 확인 필요:

## 항목별 검토
| 항목 | 현재 정보 | 리스크 | 권고 | 확인 필요 |
|---|---|---|---|---|

## 누락 정보
-

## 권고 조치
- [ ] notice/attribution 정리
- [ ] 라이선스 전문 확인
- [ ] 배포 방식 확인
- [ ] 법무 검토
```
