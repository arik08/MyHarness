---
name: learned-web-search-no-search-results-found
description: >
  Use when web_search returns no results and the task still needs external
  evidence.
---

# learned-web-search-no-search-results-found

Automatically learned guidance, generalized from prior no-result searches.

## When To Use
- Use for `web_search` no-result responses in any language.

## Generalized Lesson
- No results for one wording is not a factual absence. Generalize by source type and query strategy.
- Try alternate language, official site search, domain-specific search, registry/API lookup, RSS/feed, or direct known-source fetch.

## Recommended Next Step
- Reformulate the query with fewer constraints and source-specific terms.
- If the user named a site/source, fetch that source directly or use a platform-specific endpoint before giving up.

## Avoid
- Do not repeat near-identical queries or conclude that the information does not exist from a single no-result response.
