---
name: learned-web-search-web-search-실패-client-error-403-forbidden-
description: >
  Use when the search backend itself is blocked with 403 and research should
  continue through direct or source-specific routes.
---

# learned-web-search-web-search-실패-client-error-403-forbidden-

Automatically learned guidance, generalized from prior blocked search-backend failures.

## When To Use
- Use when `web_search` fails because the search provider or HTML search endpoint is blocked, not because the target source is unavailable.

## Generalized Lesson
- A blocked search page is a transport problem. It should not stop research.
- Move to direct known sources, official investor/news/product pages, RSS, public APIs, or `insane-search`.

## Recommended Next Step
- Identify one or two likely primary sources and fetch those directly.
- If the target page itself is blocked, escalate with `insane-search`.

## Avoid
- Do not spend attempts varying the same blocked search URL.
