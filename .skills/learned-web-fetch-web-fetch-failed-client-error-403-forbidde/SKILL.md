---
name: learned-web-fetch-web-fetch-failed-client-error-403-forbidde
description: >
  Use when direct web_fetch hits 403 Forbidden on a needed source.
---

# learned-web-fetch-web-fetch-failed-client-error-403-forbidde

Automatically learned guidance, generalized from prior 403 web-fetch failures.

## When To Use
- Use for 403 Forbidden responses from direct `web_fetch`, especially when the user requested that source or it is central to the answer.

## Generalized Lesson
- The exact blocked URL in the evidence is incidental. Generalize by platform and source type.
- For encyclopedic sources, try official APIs, mirrors, or Jina Reader where appropriate. For investor/media/product pages, look for official PDFs, RSS, API endpoints, or `insane-search`.

## Recommended Next Step
- Invoke `insane-search` for blocked central sources, or switch to a source-specific public endpoint when one exists.
- Verify that the fetched alternative actually contains the needed content before citing or summarizing it.

## Avoid
- Do not treat a local output file inspection as evidence that the original web source was successfully fetched.
