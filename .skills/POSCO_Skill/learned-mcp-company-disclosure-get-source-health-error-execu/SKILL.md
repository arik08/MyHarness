---
name: learned-mcp-company-disclosure-get-source-health-error-execu
description: >
  Use when MyHarness sees this repeated verified failure pattern: mcp__company-
  disclosure__get_source_health: Error executing tool get_source_health: Unknown source
  'eurostat_comext'. Use one of: opendart, sec, companies_house
---

# learned-mcp-company-disclosure-get-source-health-error-execu

This skill was generated automatically from a repeated, verified MyHarness failure pattern.

## Generalization Rules
- Treat stored evidence as examples, not as the only trigger.
- Before creating another `learned-*` skill, inspect existing `learned-*` skills and update or merge into a broader one when it fits.
- Prefer reusable failure classes such as platform, tool, status code, file type, or workflow step over exact URLs, paths, prompts, or IDs.
- Reuse an existing helper script, skill, API route, or validator before assembling a new one-off command.
- If the verified work is only inspection and not a real corrective path, treat the lesson as low-confidence and diagnose first.

## When To Use
- Use when MyHarness sees this repeated verified failure pattern: mcp__company-disclosure__get_source_health: Error executing tool get_source_health: Unknown source 'eurostat_comext'. Use one of: opendart, sec, companies_house

## Process
1. Read `references/learned-patterns.md` for the concrete observed pattern.
2. Apply the verified corrective path before retrying the failed approach.
3. Keep new evidence concise and avoid storing raw transcripts or secrets.

## Recommended Next Step
- Start by applying the verified corrective path: Loaded skill company-disclosure

## Avoid
- Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
