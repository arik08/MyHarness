# 검증

발표 자료의 결함은 대부분 발표 당일에 드러난다. 그 전에 잡을 수 있는 것들이 있고, 눈으로는 잡히지 않는다. 이 문서는 그 절차다.

**검증하지 않고 "다 됐습니다"라고 말하지 않는다.** 통과 항목만 나열하는 보고도 하지 않는다 — 무엇을 잡아서 고쳤는지 말한다.

## 1. 페이지 감사 (`scripts/audit.js`)

브라우저에서 덱을 열고 이 스크립트를 **페이지 컨텍스트에서** 실행한다. Claude Browser의 `javascript_tool`, playwright의 `browser_evaluate`, 또는 devtools 콘솔 — 무엇이든 된다.

```js
// scripts/audit.js 의 내용을 붙여넣는다
```

검사 항목:

| 항목 | 왜 |
|---|---|
| `stage-shrinkable` | `flex:none`이 없으면 창이 좁아지는 순간 가로만 압축된다. **렌더된 비율로 판정하지 않는다** — 창이 1920보다 크면 눌릴 여지가 없어 통과해버린다 |
| `stage-layout-size` | 무대 논리 크기가 1920×1080이 아니면 좌표계가 어긋나 있다 |
| `stage-scale-zero` | `scale(0)`이면 화면이 사라진 상태다 |
| `overflow` | 슬라이드 자체의 scroll 크기가 무대를 넘는다 |
| `content-past-stage` | 자손의 **실제 좌표**가 무대 밖으로 나갔다. flex 축소 때문에 슬라이드 높이는 그대로인 경우를 잡는다 |
| `squished-container` | flex로 눌려 내용이 박스를 흘러넘쳤다 — 화면에서 글자가 포개진다 |
| `text-clipped` | 요소 안에서 글자가 잘렸다 |
| `mono-hangul` | 코딩용 모노에는 한글 글리프가 없어 대체 서체로 떨어지고 자간이 벌어진다 |
| `hangul-uppercase` | 한글에는 효과가 없고 영문 부분만 대문자가 되어 들쭉날쭉해진다 |
| `hangul-tight` | 한글에 `-0.022em`보다 조인 자간이 걸려 글자가 붙는다 |
| `no-keep-all` | `word-break:keep-all`이 없어 어절이 낱자에서 갈라진다 |
| `step-gap` | `data-step` 번호가 비어 클릭 한 번이 헛돈다 |
| `hardcoded-slide-index` | JS에 `cur === 숫자`가 있으면 장을 끼워 넣는 순간 조용히 죽는다 |
| `no-hashchange` | 주소창에 `#/7`을 넣어도 화면이 안 바뀐다 |
| `interactive-without-noclick` | 컨트롤 옆 빈 공간을 스치면 장이 넘어가 데모 중 사고가 된다 |
| `qr-dark-bg` | 어두운 배경에 얹힌 QR은 스캔되지 않는다 |

넘침이 나오면 **글자를 줄이지 말고 장을 쪼갠다.** 줄여 밀어 넣은 장은 프로젝터 뒷줄에서 안 읽히고, 그러면 그 장은 없는 것과 같다.

넘침을 세 방식(`overflow` / `content-past-stage` / `squished-container`)으로 교차 확인하는 이유가 있다. `.slide`는 flex 컨테이너이고 flex 자식은 기본적으로 축소되므로, **내용이 넘쳐도 컨테이너 높이는 그대로**인 경우가 흔하다. `scrollHeight` 하나만 보면 그 경우를 통째로 놓친다.

`squished-container`를 `scrollHeight`로 판정하면 안 된다 — `table`과 grid는 테두리·`border-spacing` 때문에 `scrollHeight`가 `clientHeight`보다 계통적으로 9~10px 크게 나와서 전부 오탐이 된다. 자식의 실제 좌표로 본다.

콘솔 에러는 감사와 별도로 브라우저에서 직접 확인한다. favicon 404가 가장 흔하다 — 인라인 data URI로 막는다.

## 2. 대비 — 반드시 픽셀로 잰다

### 계산된 배경색으로는 검사되지 않는다

`getComputedStyle(el).backgroundColor`를 읽어 대비를 계산하는 방식은 **그라데이션 배경에서 완전히 무효하다.** 그라데이션은 `background-image`이고 슬라이드는 대개 `transparent`라, 계산된 색으로 재면 전부 통과로 나온다. 실제로는 발광 오브가 지나가는 자리에서 보조 텍스트가 3:1 아래로 떨어져 있어도 모른다.

### 절차

**① 텍스트를 감추고 배경만 렌더한 스크린샷을 찍는다.**

```js
document.querySelectorAll('.slide').forEach(s => s.style.visibility='hidden');
['progress','counter','chapter-tag'].forEach(id => {
  const el = document.getElementById(id); if (el) el.style.visibility='hidden';
});
```

**② 픽셀을 그냥 읽지 않는다.**

이게 실제로 한 번 틀렸던 지점이다. 픽셀 최댓값을 그대로 찾으면 1~2px 입자(별·신호점)나 굵은 제목 획을 **배경으로 오독한다.** 그 결과 "배경이 너무 밝다"는 잘못된 진단이 나오고, 배경을 어둡게 해도 수치가 안 움직인다.

블록 평균을 낸 뒤 최명부를 찾는다. `scripts/contrast.py`가 이걸 한다.

```bash
python scripts/contrast.py bgonly.png "#EBF2F8" "#B8C7D4" "#8CD2F5" "#4FD8AE" "#F8C96A" "#FF8A7B"
```

**③ 배경을 어둡게 하는 것보다 강조색을 밝게 올리는 쪽이 효과적이다.**

배경을 어둡게 하면 그라데이션의 풍부함이 사라지고, 게다가 최명부는 대개 오브의 광원부라 알파를 줄여도 잘 안 내려간다. 글자색을 한 단 올리는 편이 정확하고 부작용이 없다.

목표: 본문·메타 텍스트 전부 배경 최명부 대비 **4.5:1 이상**.

## 3. 실제 화면으로 본다

숫자가 통과해도 눈으로 봐야 하는 것들이 있다.

- 표지, 관통 사례의 핵심 장, 데이터가 가장 많은 장 — 최소 이 셋은 스크린샷으로 확인한다
- 줄바꿈이 어색한 곳 (`keep-all`을 넣어도 어절이 길면 어색해진다)
- 단계 노출이 말하는 순서와 맞는지
- 라이브 위젯을 실제로 조작해 값이 맞게 나오는지 (프리셋 전부 눌러본다)

## 4. 발표 환경

| 확인 | 방법 |
|---|---|
| 전체화면에서 안 깨지는지 | `F` 누르고 확인 |
| 딥링크가 되는지 | 주소창에 `#/7` 넣어보기 — `hashchange`를 안 듣고 있으면 화면이 그대로다 |
| 폰트가 오프라인에서 어떻게 되는지 | CDN이면 폴백이 무엇인지 확인하고 사용자에게 알린다 |
| 백업 PDF | `python scripts/export_pdf.py deck.html` |
| QR이 실제로 스캔되는지 | 어두운 배경에 얹었으면 흰 카드와 여백(quiet zone)이 있는지 확인 |

## 보고 형식

검증 결과는 이렇게 전한다. 무엇을 검사했고, 무엇이 걸렸고, 어떻게 고쳤는지.

```
N장 전부 넘침 0 · 모노 한글 잔존 0 · 콘솔 에러 0
대비: 렌더 픽셀 기준 최악 4.60:1 (배경 최명부 L=0.0722 대조) — 전 색상 AA 통과

고친 것
- flex-shrink가 무대를 1920→1280으로 압축 (가로만 찌그러진 상태였음)
- 숨은 탭 로드 시 scale(0)으로 화면 소실
- ink-faint가 그라데이션 최명부에서 3.68:1 → #B8C7D4로 상향
```
