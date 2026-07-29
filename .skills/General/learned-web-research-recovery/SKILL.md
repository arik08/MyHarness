---
name: learned-web-research-recovery
description: Use when web search or direct web fetch returns no results, 400, 403, 404, sparse pages, blocked content, or guessed raw file URLs during source-backed research.
---

# Learned Web Research Recovery

Automatically consolidated guidance from prior `learned-web-*` and web-fetch failure skills.

## When To Use
- `web_search` returns no results in Korean or English.
- Search backend or direct fetch returns 400, 403, 404, blocked, sparse, or bot-protected content.
- A raw GitHub/file URL was guessed and returned 404.
- The user still needs current, source-backed information.

## Core Lesson
- A failed search or fetch is usually a route problem, not proof that the information does not exist.
- Generalize by source type and failure class. Treat old URLs as examples only.
- Prefer primary or structured routes: official docs/site search, RSS/feed, public API, GitHub API/tree listing, Jina Reader for ordinary HTML, `insane-search` for blocked central sources, and browser rendering only when JavaScript is required.

## Quick Actions
| Failure | Do |
|---|---|
| No search results | Reformulate with fewer constraints, bilingual terms, source-specific names, or direct official pages. |
| Search backend 403 | Stop varying the same search URL; go to likely primary sources, RSS, APIs, or `insane-search`. |
| Direct page 403/blocked | Try official alternate route, source-specific API, Jina Reader, or `insane-search`; verify the alternate source contains the needed claim. |
| Direct URL 404 | Verify owner, repo, branch, and path through structured listing before trying adjacent guessed URLs. |
| 400 from fetch | Check URL encoding, query parameters, and whether the endpoint needs a structured API/client route. |

## Avoid
- Do not answer from a generated local report as if it were the primary source.
- Do not conclude absence from one no-result query.
- Do not keep chasing near-identical blocked URLs.
