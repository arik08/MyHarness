---
name: learned-category-web-fetch
description: >
  Use when direct web_fetch repeatedly fails or returns blocked/sparse content
  and the answer still needs the source.
---

# learned-category-web-fetch

Automatically learned guidance, generalized from prior blocked web-fetch failures.

## When To Use
- Use for repeated `web_fetch` failures such as 401, 402, 403, 429, bot/WAF blocks, unexpectedly sparse pages, or fetch routes that keep chasing the same inaccessible HTML page.

## Generalized Lesson
- Treat the stored URLs as examples only. Generalize by site/platform and failure type.
- Prefer source-specific routes: OpenWeb typed site operations for supported platforms, official API, RSS/feed, Jina Reader for ordinary HTML, `insane-search` fallback for blocked central sources, or browser/Playwright only when JavaScript rendering is actually required.

## Recommended Next Step
- If the user requested the source directly or the source is central, check whether OpenWeb supports the platform and try its relevant read operation first.
- If OpenWeb is unsupported, insufficient, or blocked by login/session requirements, invoke `insane-search` before giving up.
- If a public API or structured endpoint exists, use that before trying more HTML fetch variants.

## Avoid
- Do not conclude from one blocked page that the source cannot be analyzed.
- Do not treat a local saved artifact or unrelated file inspection as proof that the web source was fetched.
