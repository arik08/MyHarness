---
name: learned-web-fetch-404-newsroom-posco-com
description: >
  Use when MyHarness sees this repeated verified failure pattern: web_fetch
  input=https://newsroom.posco.com/kr/포스코홀딩스-한국산업은행과-지역-벤처-생태계-활성화-위해-협력/: web_fetch 실패:
  Client error '404 Not Found' for url 'https://newsroom.posco.co
---

# learned-web-fetch-404-newsroom-posco-com

This skill was generated automatically from a repeated, verified MyHarness failure pattern.

## Generalization Rules
- Treat stored evidence as examples, not as the only trigger.
- Prefer reusable failure classes such as platform, tool, status code, file type, or workflow step over exact URLs, paths, prompts, or IDs.
- Reuse an existing helper script, skill, API route, or validator before assembling a new one-off command.
- If the verified work is only inspection and not a real corrective path, treat the lesson as low-confidence and diagnose first.

## When To Use
- Use when MyHarness sees this repeated verified failure pattern: web_fetch input=https://newsroom.posco.com/kr/포스코홀딩스-한국산업은행과-지역-벤처-생태계-활성화-위해-협력/: web_fetch 실패: Client error '404 Not Found' for url 'https://newsroom.posco.co

## Process
1. Read `references/learned-patterns.md` for the concrete observed pattern.
2. Apply the verified corrective path before retrying the failed approach.
3. Keep new evidence concise and avoid storing raw transcripts or secrets.

## Recommended Next Step
- Start by applying the verified corrective path: Fetched remote content from https://newsroom.posco.com/kr/특별기고-지속가능한-미래-철강산업의-저탄소-전환/

## Avoid
- Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
