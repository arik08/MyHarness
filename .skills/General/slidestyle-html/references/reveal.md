# 단계 노출과 모션

## 모션을 쓸 자리

발표 덱에서 모션의 값은 **주의를 옮기는 것**이다. 예쁘게 보이는 것이 아니다. 그래서 판단 기준은 하나다 — 이 움직임이 청중의 눈을 지금 봐야 할 곳으로 옮기는가.

한 덱에 네 곳 이하로 제한한다. 전부 움직이면 아무것도 움직이지 않는 것과 같고, 과한 애니메이션은 자료가 자동 생성된 것처럼 보이게 만든다.

쓸 만한 네 자리:

| 자리 | 연출 | 왜 |
|---|---|---|
| 여러 항목을 순서대로 말할 때 | 단계 노출 (`data-step`) | 말과 화면이 같이 간다. 미리 다 보이면 청중이 먼저 읽고 발표를 안 듣는다 |
| 인과·경로를 설명할 때 | SVG 선이 한 단계씩 그려짐 | 인과를 말로 설명하면 안 들어오고, 그려지면 들어온다 |
| 규모를 말할 때 | 숫자 카운트업 | 0에서 올라가는 동안 청중이 숫자를 본다 |
| 결론이 뒤집히는 것을 보여줄 때 | 라이브 계산 위젯 | 발표자가 값을 움직여 부호가 바뀌는 걸 실제로 보여준다 |

## 단계 노출

```html
<div class="panel" data-step="1">먼저</div>
<div class="panel" data-step="2">다음</div>
<p class="closer" data-step="3">결론</p>
```

같은 번호를 여러 요소에 주면 함께 나온다. 항목이 6개인데 6단계로 쪼개면 클릭이 너무 많아지므로 2~3개씩 묶는다.

**장 번호로 애니메이션을 묶지 않는다.** `if (cur === 17) runCounts()` 식으로 쓰면 슬라이드를 하나 끼워 넣는 순간 번호가 밀려 조용히 죽는다. 발표 당일에야 알게 되는 종류의 사고다. 내용으로 판정한다.

```js
if (slides[cur].querySelector('[data-count]')) runCounts();
```

## SVG 순차 드로잉

`stroke-dasharray` / `stroke-dashoffset`로 선을 그린다.

```css
.flow{ stroke-dasharray:var(--len); stroke-dashoffset:var(--len);
       transition:stroke-dashoffset .7s ease; }
.flow.drawn{ stroke-dashoffset:0 }
```
```js
flows.forEach(p => p.style.setProperty('--len', p.getTotalLength()));
```

**`marker-end`로 화살촉을 붙이면 안 된다.** marker는 `stroke-dasharray`와 무관하게 즉시 렌더되므로, 선이 그려지기 전에 화살촉만 공중에 떠 있는 화면이 된다.

꺾쇠를 같은 path에 이어 붙인다. 한 path의 dash 진행이 첫 서브패스를 지나 두 번째로 넘어가므로 **선 → 화살촉** 순서로 그려진다.

```html
<path class="flow" d="M376 169 H428 M419 160 L428 169 L419 178"/>
```

## 카운트업

```js
const dur = 900, t0 = performance.now();
(function tick(t){
  const k = Math.min(1, (t - t0) / dur);
  node.textContent = Math.round(target * (1 - Math.pow(1 - k, 3)));  // ease-out cubic
  if (k < 1) requestAnimationFrame(tick);
})(t0);
```

`prefers-reduced-motion`이면 최종값을 바로 넣는다.

카운트업 숫자는 모노 서체 + `font-variant-numeric: tabular-nums`로 둔다. 아니면 자릿수가 바뀔 때마다 폭이 흔들려 숫자가 춤춘다.

## 라이브 위젯

덱 안에서 값이 실제로 움직이는 순간은 데모의 대체물이 된다. 외부 라이브러리 없이 직접 짠다 — 계산식이 단순하면 20줄이면 된다.

지켜야 할 것:

- **그 장에 `data-noclick`을 붙인다.** 슬라이더나 버튼 옆 빈 공간을 스치면 장이 넘어가서, 발표 중에 그대로 사고가 된다.
- 클릭 넘김 핸들러에서 `input,button,a,select,textarea`는 이미 제외되지만, 그것만으로는 부족하다.
- 프리셋 버튼을 둔다. 발표 중에 슬라이더를 정확한 값으로 맞추기는 어렵다. "방어 / 기준 / 압박"처럼 눌러서 바로 가는 지점을 만들어 둔다.
- **어떤 변수가 결론을 뒤집는지**를 위젯이 드러내야 한다. 값을 바꿀 수 있다는 것 자체는 흥미롭지 않다. 하나만 움직였는데 부호가 바뀌는 걸 보여줄 때 의미가 생긴다.

숫자를 크게 띄울 때는 그 숫자가 **확인값인지 가정인지** 옆에 붙인다. 발표에서 큰 숫자는 근거 없이도 사실처럼 읽히므로, 가정이면 가정이라고 적는 것이 정직하고 오히려 신뢰를 얻는다.

## 장 전환

`opacity` 페이드 0.34초면 충분하다. 슬라이드가 밀려 들어오는 연출은 20장을 넘기면 피곤해진다.

전환 중에 진행 표시가 같이 사라지지 않도록 `.slide` 밖에 두고 `z-index`를 올린다.
