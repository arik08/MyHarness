---
name: learned-web-search-no-results
description: >
  Use when MyHarness sees this repeated verified failure pattern: web_search
  input=site:poscohrd.com "DX 교육" "뉴칼라": 검색 결과가 없습니다.
---

# learned-web-search-no-results

This skill was generated automatically from a repeated, verified MyHarness failure pattern.

## Generalization Rules
- Treat stored evidence as examples, not as the only trigger.
- Before creating another `learned-*` skill, inspect existing `learned-*` skills and update or merge into a broader one when it fits.
- Prefer reusable failure classes such as platform, tool, status code, file type, or workflow step over exact URLs, paths, prompts, or IDs.
- Reuse an existing helper script, skill, API route, or validator before assembling a new one-off command.
- If the verified work is only inspection and not a real corrective path, treat the lesson as low-confidence and diagnose first.

## When To Use
- Use when MyHarness sees this repeated verified failure pattern: web_search input=site:poscohrd.com "DX 교육" "뉴칼라": 검색 결과가 없습니다.

## Process
1. Read `references/learned-patterns.md` for the concrete observed pattern.
2. Apply the verified corrective path before retrying the failed approach.
3. Keep new evidence concise and avoid storing raw transcripts or secrets.

## Recommended Next Step
- Start by applying the verified corrective path: Ran command python -c "from pathlib import Path; p=Path('outputs/포스코인재창조원_DX교육그룹_업무분석.html'); print([repr(x) for x in p.read_text(encoding='utf-8').splitlines() if '런투' in [['\'&quot;포스코그룹 뉴스룸 런투게더 3편&quot;">10</a></sup></p></div></div>\'',

## Avoid
- Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
