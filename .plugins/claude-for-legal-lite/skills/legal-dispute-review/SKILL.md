---
name: legal-dispute-review
description: 분쟁, demand letter, subpoena, legal hold, chronology, privilege log, brief section 초안을 정리합니다. 사용자가 제공한 자료 안에서 사건 타임라인, 쟁점, 증거 공백, 변호사 검토용 메모를 만들 때 사용합니다.
---

# Legal Lite Dispute Review

## 목적

사용자가 제공한 자료만으로 분쟁/소송 관련 초안 작업을 구조화합니다. docket, 판례, 법원 기록 자동 조회는 하지 않습니다.

## 전제

- 법원 제출, 상대방 발송, 보전 통지, 증거 제출은 변호사 검토 전 실행하지 않습니다.
- privilege, work product, settlement communication 이슈를 보수적으로 표시합니다.
- 판례/절차/기한은 사용자 제공 자료가 없으면 `[법무 확인 필요]`로 둡니다.

## 가능한 작업

- 사건 chronology 작성
- demand letter 초안 또는 수신 demand triage
- subpoena 대응 체크리스트
- legal hold 초안/갱신 메모
- privilege log 1차 검토
- brief section 구조 초안
- 외부 counsel 전달용 matter summary

## 진행

1. 당사자, 관할, 사건 단계, 기한, 발송/제출 대상 확인
2. 날짜순 사실과 출처를 분리
3. 쟁점, 증거, 공백, 리스크를 표로 정리
4. privilege 또는 외부 전달 위험이 있는 문구를 표시
5. 다음 조치를 법무 검토/사업부 입력/자료 수집으로 나눕니다.

## 출력 형식

```md
# 분쟁 검토 초안: [사건/상대방]

## 현재 상태
- 단계:
- 핵심 기한:
- 즉시 조치:

## Chronology
| 날짜 | 사건 | 출처 | 확인 필요 |
|---|---|---|---|

## 쟁점과 증거
| 쟁점 | 관련 사실 | 보유 자료 | 공백 | 다음 조치 |
|---|---|---|---|---|

## Privilege/외부 전달 주의
-

## 변호사에게 물어볼 질문
-
```
