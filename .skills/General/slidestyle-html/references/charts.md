# 차트

발표에서 차트는 **문장보다 빨리 이해시킬 때만** 값이 있다. 숫자가 셋 이하면 그냥 크게 쓰는 편이 낫고, 추세나 비교가 한눈에 보여야 할 때 차트가 이긴다.

라이브러리를 쓰지 않는다. 단일 파일 원칙이 깨지고, 행사장 네트워크가 죽으면 차트만 빈칸이 된다. 아래 패턴은 전부 CSS + 약간의 JS로 만든다.

## 차트가 필요한지 먼저 판단한다

| 상황 | 쓸 것 |
|---|---|
| 숫자 2~4개를 나란히 | 차트 말고 **큰 숫자**(`.stat`) |
| 시간에 따른 변화 | 막대 또는 타임라인 |
| 항목별 크기 비교 | 가로 막대 (레이블이 길 때 특히) |
| 구성비 | 누적 막대 하나. 도넛은 값 읽기가 어렵다 |
| 두 시나리오 비교 | 표. 차트로 만들면 오히려 안 읽힌다 |
| 인과·경로 | 차트 아님 → `reveal.md`의 SVG 순차 드로잉 |

축·단위·기준일을 반드시 붙인다. 붙일 게 없으면 그 숫자는 아직 발표에 낼 준비가 안 된 것이다.

## 세로 막대 (시간축)

값은 최댓값 대비 백분율을 `data-h`에 넣고, 장이 열릴 때 순차로 차오르게 한다.

```html
<div class="chart">
  <div class="chart-col"><div class="chart-val">7</div><div class="chart-bar" data-h="78"></div></div>
  <div class="chart-col"><div class="chart-val">9</div><div class="chart-bar" data-h="100"></div></div>
  <div class="chart-col">
    <div class="chart-note">3주 공백</div>
    <div class="chart-val zero">0</div><div class="chart-bar gap" data-h="3"></div>
  </div>
</div>
<div class="chart-x"><div>7/25</div><div>7/26</div><div>7/30 ~ 8/18</div></div>
```

```css
.chart{display:flex;align-items:flex-end;height:400px;
  border-bottom:2px solid var(--line)}
.chart-col{flex:1;display:flex;flex-direction:column;justify-content:flex-end;
  align-items:center;height:100%;position:relative}
.chart-bar{width:64%;background:var(--brand);border-radius:3px 3px 0 0;height:0;
  transition:height .8s cubic-bezier(.22,.7,.3,1)}
.chart-bar.gap{background:var(--line);opacity:.6}   /* 값이 0인 구간 */
.chart-val{font-family:var(--font-mono);font-size:26px;font-weight:600;
  color:var(--brand);margin-bottom:10px;font-variant-numeric:tabular-nums}
.chart-x{display:flex;margin-top:14px}
.chart-x div{flex:1;text-align:center;font-size:20px;color:var(--ink-faint)}
```

```js
document.querySelectorAll('.chart-bar').forEach((b,i) => {
  setTimeout(() => { b.style.height = b.dataset.h + '%' }, reduce ? 0 : i * 90);
});
```

**값 라벨을 막대 위에 직접 쓴다.** y축 눈금을 만들면 청중이 눈으로 값을 읽어야 하고, 발표 속도에서는 아무도 그걸 하지 않는다. 눈금 대신 숫자를 얹는다.

`.chart-x`는 `.chart` 밖에 두고 같은 flex 분할을 쓴다 — 막대 안에 넣으면 막대 높이 계산에 섞인다.

## 가로 막대 (항목 비교)

한글 레이블은 길어서 세로 막대의 x축에 넣으면 겹친다. 항목이 4개 이상이거나 레이블이 길면 가로로 눕힌다.

```html
<div class="bar-row">
  <div class="bar-label">정책·규제</div>
  <div class="bar-track"><div class="bar-fill" data-pct="100"></div></div>
  <div class="bar-value">21건</div>
</div>
```

```css
.bar-row{display:grid;grid-template-columns:200px 1fr 110px;gap:22px;
  align-items:center;margin-bottom:18px}
.bar-label{font-size:27px;color:var(--ink)}
.bar-track{height:42px;background:var(--neutral);overflow:hidden}
.bar-fill{height:100%;width:0;background:var(--brand);
  transition:width .85s cubic-bezier(.22,.7,.3,1)}
.bar-value{font-size:29px;font-weight:800;text-align:right;
  font-variant-numeric:tabular-nums;color:var(--brand)}
```

값 라벨에 단위(`건`, `%`)가 붙으면 한글이 섞이므로 **모노를 걸지 않는다** — `font-variant-numeric`만으로 자릿수를 정렬한다.

의미가 다른 막대는 색을 달리한다. 예: 강조하려는 항목만 `--brand`, 나머지는 `--line` 계열.

## 분포를 선별의 증거로 쓰기

막대 차트가 가장 세게 작동하는 자리는 "많다"가 아니라 **"걸러냈다"**를 보일 때다.

```
영향도 5점  ████████████████  34건
영향도 4점  ███████████       24건
영향도 3점  ▏                  1건
```

남은 것이 전부 고영향이라는 사실은 수집력이 아니라 선별력의 증거다. 이 해석을 차트 아래 한 문장으로 반드시 붙인다 — 차트만 두면 청중은 "숫자가 많네"로 읽는다.

## 절대 하지 말 것

- **y축을 0에서 시작하지 않기.** 차이를 과장하는 것으로 보이고, 심사 자리에서 지적당한다.
- **3D·그림자·그라데이션 채움.** 값을 읽기 어렵게만 만든다.
- **색만으로 계열 구분.** 범례를 눈으로 왕복해야 한다. 계열이 둘 이상이면 막대에 직접 라벨을 붙인다.
- **없는 데이터를 채워 넣기.** 값이 0인 구간은 0으로 두고 색을 죽인다. 그 공백 자체가 정보다.
