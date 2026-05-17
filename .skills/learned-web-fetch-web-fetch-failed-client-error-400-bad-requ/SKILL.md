---
name: learned-web-fetch-web-fetch-failed-client-error-400-bad-requ
description: >
  Use when a web-fetch fallback URL is malformed, especially nested Jina Reader
  prefixes or duplicated protocol wrappers.
---

# learned-web-fetch-web-fetch-failed-client-error-400-bad-requ

Automatically learned guidance, generalized from prior malformed fallback fetches.

## When To Use
- Use for 400 Bad Request errors caused by fallback URL construction, such as nested `r.jina.ai/http://r.jina.ai/...` URLs or malformed protocol prefixes.

## Generalized Lesson
- A 400 from the fallback service usually means the wrapper URL is wrong, not that the target source is unavailable.
- Reconstruct the fallback from the original target URL once, or choose another source-specific route.

## Recommended Next Step
- Strip duplicate wrappers and retry from the canonical original URL.
- If the target site has an official API, RSS, or structured endpoint, use that instead of stacking generic fetch fallbacks.

## Avoid
- Do not keep prepending Jina Reader or proxy prefixes to an already-wrapped URL.
