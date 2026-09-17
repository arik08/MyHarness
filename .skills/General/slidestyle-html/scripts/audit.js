/* slidestyle-html 페이지 감사.
 *
 * 브라우저의 페이지 컨텍스트에서 실행한다 (javascript_tool / browser_evaluate /
 * devtools 콘솔). JSON 문자열을 돌려준다.
 *
 * 서체 로딩을 기다려야 넘침 측정이 정확하므로 document.fonts.ready 뒤에 잰다.
 * 반환이 Promise이므로 도구가 await 하지 않으면 .then 으로 감싸 쓴다.
 */
(() => document.fonts.ready.then(() => {
  const out = { ok: true, problems: [], info: {} };
  const fail = (kind, detail) => { out.ok = false; out.problems.push({ kind, ...detail }); };

  const stage  = document.getElementById('stage');
  const slides = [...document.querySelectorAll('.slide')];
  out.info.slides = slides.length;

  /* ── 1. 무대 ───────────────────────────────────────────────────── */
  const STAGE_W = 1920, STAGE_H = 1080;
  /* 자식이 부모 박스를 이만큼 넘으면 겹침으로 본다. 테두리·서브픽셀 오차를
     흡수할 만큼 여유를 두되, 한 줄(약 45px)보다는 작게 잡는다. */
  const SPILL_TOLERANCE = 16;
  let scale = 1;

  if (!stage) {
    fail('no-stage', { hint: '#stage 가 없다' });
  } else {
    const r = stage.getBoundingClientRect();
    const cs = getComputedStyle(stage);
    scale = r.width / (parseFloat(cs.width) || STAGE_W) || 1;
    out.info.stage = { layoutW: Math.round(parseFloat(cs.width)),
                       layoutH: Math.round(parseFloat(cs.height)),
                       renderedRatio: +(r.width / r.height).toFixed(3),
                       transform: stage.style.transform, flexShrink: cs.flexShrink };

    /* flex-shrink 를 직접 본다. 렌더된 비율로 판정하면 창이 무대보다 클 때는
       눌릴 여지가 없어 통과해버린다 — 창 크기에 의존하지 않는 검사가 필요하다. */
    if (parseFloat(cs.flexShrink) !== 0 &&
        getComputedStyle(stage.parentElement || document.body).display.includes('flex'))
      fail('stage-shrinkable', { flexShrink: cs.flexShrink,
        hint: '#stage 에 flex:none 이 없다. 창이 1920보다 좁아지는 순간 가로만 압축된다' });

    // 논리 크기가 1920×1080 이 아니면 좌표계가 어긋나 있다
    const lw = parseFloat(cs.width), lh = parseFloat(cs.height);
    if (Math.abs(lw - STAGE_W) > 1 || Math.abs(lh - STAGE_H) > 1)
      fail('stage-layout-size', { got: [Math.round(lw), Math.round(lh)],
        expected: [STAGE_W, STAGE_H],
        hint: '무대의 레이아웃 크기가 논리 좌표와 다르다 (눌렸거나 토큰이 틀렸다)' });

    // scale(0) 이면 화면이 사라진 상태다
    const m = /scale\(([\d.]+)\)/.exec(stage.style.transform || '');
    if (m && parseFloat(m[1]) === 0)
      fail('stage-scale-zero', { hint: 'innerWidth 가 0인 시점에 계산됐다. fitStage 에 0 가드 필요' });
    if (!stage.style.transform)
      fail('stage-no-transform', { hint: 'fitStage 가 한 번도 안 돌았다' });
  }

  /* ── 2. 전 슬라이드 넘침 (모든 단계 노출 상태) ────────────────────
   * 슬라이드의 scrollHeight 만 보면 안 된다. .slide 는 flex 컨테이너이고
   * flex 자식은 기본적으로 축소되므로, 내용이 넘쳐도 컨테이너 높이는 그대로고
   * **글자가 자기 박스를 넘친다.** 그래서 세 가지를 함께 본다:
   *   (a) 슬라이드 자체의 scroll 크기
   *   (b) 자손 요소가 무대 경계를 벗어나는지 (실제 좌표)
   *   (c) 자손 요소가 자기 박스 안에서 잘리는지
   */
  const stageRect = stage ? stage.getBoundingClientRect() : null;
  slides.forEach((sl, i) => {
    const cls = sl.className;
    const steps = [...sl.querySelectorAll('[data-step]')];
    sl.classList.add('is-active');
    steps.forEach(e => e.classList.add('is-shown'));

    // (a)
    if (sl.scrollHeight > STAGE_H + 2 || sl.scrollWidth > STAGE_W + 2)
      fail('overflow', { slide: i + 1, h: sl.scrollHeight, w: sl.scrollWidth,
        over: sl.scrollHeight - STAGE_H, hint: '글자를 줄이지 말고 장을 쪼갠다' });

    if (stageRect) {
      let worstBottom = 0, culprit = null, clipped = null, squished = null;
      sl.querySelectorAll('*').forEach(el => {
        const txt = (el.textContent || '').trim();
        if (!txt) return;
        const r = el.getBoundingClientRect();
        if (!r.height) return;
        // (b) 무대 좌표로 환산한 하단 위치
        const bottom = (r.bottom - stageRect.top) / (scale || 1);
        if (bottom > worstBottom) { worstBottom = bottom; culprit = el; }
        // (c) 자기 박스 안에서 잘리는 글자
        if (el.children.length === 0 &&
            el.scrollHeight > el.clientHeight + 2 &&
            getComputedStyle(el).overflowY !== 'visible')
          clipped = clipped || { text: txt.slice(0, 30),
                                 scroll: el.scrollHeight, client: el.clientHeight };
        /* (d) flex 로 눌려 내용이 자기 박스를 흘러넘친 컨테이너.
           무대 안에는 들어가므로 (a)(b) 로는 안 잡히지만, 실제 화면에서는
           아래 요소와 글자가 포개진다.
         *
         * scrollHeight 로 판정하면 안 된다 — table 이나 grid 는 테두리·
         * border-spacing 때문에 scrollHeight 가 clientHeight 보다 계통적으로
         * 9~10px 크게 나와서 전부 오탐이 된다. 자식의 **실제 좌표**가 부모
         * 박스를 벗어나는지로 본다. */
        if (el.children.length && getComputedStyle(el).overflowY === 'visible') {
          const box = el.getBoundingClientRect();
          let spill = 0;
          for (const kid of el.children) {
            const kr = kid.getBoundingClientRect();
            if (!kr.height) continue;
            spill = Math.max(spill, kr.bottom - box.bottom);
          }
          if (spill / (scale || 1) > SPILL_TOLERANCE)
            squished = squished || { tag: el.className || el.tagName,
                                     spill: Math.round(spill / (scale || 1)) };
        }
      });
      if (worstBottom > STAGE_H + 2)
        fail('content-past-stage', { slide: i + 1, bottom: Math.round(worstBottom),
          over: Math.round(worstBottom - STAGE_H),
          text: culprit ? (culprit.textContent || '').trim().slice(0, 30) : null,
          hint: 'flex 축소로 슬라이드 높이는 그대로인데 내용이 무대 밖으로 나갔다. 장을 쪼갠다' });
      if (clipped)
        fail('text-clipped', { slide: i + 1, ...clipped,
          hint: '요소 안에서 글자가 잘렸다' });
      if (squished)
        fail('squished-container', { slide: i + 1, ...squished,
          hint: 'flex 로 눌려 내용이 박스를 흘러넘쳤다. 화면에서는 아래 요소와 글자가 포개진다' });
    }

    sl.className = cls;
    steps.forEach(e => e.classList.remove('is-shown'));
  });

  /* ── 3. 모노 서체에 갇힌 한글 ───────────────────────────────────── */
  /* 코딩용 모노 서체에는 한글 글리프가 없다. 걸어두면 그 글자만 대체 서체로
     떨어지고 letter-spacing 까지 겹쳐 자간이 벌어진다. */
  const hangul = /[가-힣]/;
  const MONO = /Mono|Consolas|Courier|monospace/i;
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length) return;                       // 말단 노드만
    const txt = (el.textContent || '').trim();
    if (!txt || !hangul.test(txt)) return;
    const st = getComputedStyle(el);
    if (MONO.test(st.fontFamily))
      fail('mono-hangul', { text: txt.slice(0, 34), font: st.fontFamily.split(',')[0],
        letterSpacing: st.letterSpacing,
        hint: '모노는 라틴·숫자 전용이다. ID만 <b class="mono"> 로 감싸고 한글은 본문 서체로' });
  });

  /* ── 4. 한글에 text-transform / 과한 음수 자간 ──────────────────── */
  document.querySelectorAll('*').forEach(el => {
    if (el.children.length) return;
    const txt = (el.textContent || '').trim();
    if (!txt || !hangul.test(txt)) return;
    const st = getComputedStyle(el);
    if (st.textTransform === 'uppercase')
      fail('hangul-uppercase', { text: txt.slice(0, 26),
        hint: '한글에는 효과가 없고 영문 부분만 대문자가 되어 들쭉날쭉해진다' });
    const fs = parseFloat(st.fontSize);
    const ls = parseFloat(st.letterSpacing);
    if (fs >= 40 && Number.isFinite(ls) && ls / fs < -0.022)
      fail('hangul-tight', { text: txt.slice(0, 26), em: +(ls / fs).toFixed(4),
        hint: '한글은 -0.018em 보다 조이면 글자가 붙는다' });
  });

  /* ── 5. word-break ─────────────────────────────────────────────── */
  if (getComputedStyle(document.body).wordBreak !== 'keep-all')
    fail('no-keep-all', { hint: "body 에 word-break:keep-all 이 없어 '선행조건'이 낱자에서 갈라진다" });

  /* ── 6. 단계 정합성 ─────────────────────────────────────────────── */
  const stepInfo = slides.map((sl, i) => {
    const ns = [...sl.querySelectorAll('[data-step]')].map(e => +e.dataset.step);
    const max = ns.length ? Math.max(...ns) : 0;
    const uniq = [...new Set(ns)].sort((a, b) => a - b);
    // 1,2,4 처럼 번호가 비면 클릭 한 번이 헛돈다
    const gaps = uniq.filter((n, k) => n !== k + 1);
    if (gaps.length) fail('step-gap', { slide: i + 1, declared: uniq,
      hint: 'data-step 번호는 1부터 연속이어야 한다' });
    return { slide: i + 1, steps: max };
  });
  out.info.steps = stepInfo.filter(s => s.steps > 0);

  /* ── 7. 하드코딩된 장 번호 ──────────────────────────────────────── */
  const src = [...document.querySelectorAll('script')].map(s => s.textContent).join('\n');
  const hard = src.match(/cur\s*===?\s*\d+/g);
  if (hard) fail('hardcoded-slide-index', { found: [...new Set(hard)],
    hint: '장을 하나 끼워 넣으면 조용히 죽는다. slides[cur].querySelector(...) 로 내용 판정' });

  /* ── 8. 접근성·발표 기본기 ──────────────────────────────────────── */
  if (!/hashchange/.test(src))
    fail('no-hashchange', { hint: '주소창에 #/7 을 넣어도 화면이 안 바뀐다' });
  if (!/prefers-reduced-motion/.test([...document.styleSheets].length ? src : src) &&
      !document.querySelector('style, link[rel=stylesheet]'))
    { /* 스타일 접근 불가 — 건너뜀 */ }

  const interactive = document.querySelectorAll('input,button,select,textarea');
  if (interactive.length) {
    const noclick = document.querySelectorAll('[data-noclick]').length;
    if (!noclick) fail('interactive-without-noclick', { controls: interactive.length,
      hint: '컨트롤이 있는 장에 data-noclick 이 없다. 옆 빈 공간을 스치면 장이 넘어간다' });
  }

  const qr = document.querySelectorAll('.qr, [data-qr]');
  qr.forEach(el => {
    const bg = getComputedStyle(el).backgroundColor;
    const rgb = (bg.match(/\d+/g) || []).map(Number);
    if (rgb.length >= 3 && (rgb[0] + rgb[1] + rgb[2]) / 3 < 200)
      fail('qr-dark-bg', { hint: 'QR은 흰 카드와 여백(quiet zone)이 있어야 스캔된다' });
  });

  out.info.summary = out.ok
    ? `통과 — 슬라이드 ${slides.length}장`
    : `문제 ${out.problems.length}건`;
  return JSON.stringify(out, null, 1);
}))()
