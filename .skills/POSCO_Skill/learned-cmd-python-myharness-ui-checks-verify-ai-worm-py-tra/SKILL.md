---
name: learned-cmd-python-myharness-ui-checks-verify-ai-worm-py-tra
description: >
  Use when a visual validation command fails because its helper path is machine-specific, temporary, or missing.
---

# learned-cmd-python-myharness-ui-checks-verify-ai-worm-py-tra

This skill was generated automatically from a repeated, verified MyHarness failure pattern.

## Generalization Rules
- Treat stored evidence as examples, not as the only trigger.
- Before creating another `learned-*` skill, inspect existing `learned-*` skills and update or merge into a broader one when it fits.
- Prefer reusable failure classes such as platform, tool, status code, file type, or workflow step over exact URLs, paths, prompts, or IDs.
- Reuse an existing helper script, skill, API route, or validator before assembling a new one-off command.
- If the verified work is only inspection and not a real corrective path, treat the lesson as low-confidence and diagnose first.

## When To Use
- Use when a visual validation helper path is machine-specific, temporary, or missing.

## Process
1. Read `references/learned-patterns.md` for the concrete observed pattern.
2. Diagnose the error, resolve the helper from the active installation, and inspect its CLI before retrying.
3. Keep new evidence concise and avoid storing raw transcripts or secrets.

## Recommended Next Step
- Locate the installed visual-review skill, verify its helper exists, and validate the current artifact with supported arguments.

## Avoid
- Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
