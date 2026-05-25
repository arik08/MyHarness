---
name: learned-cmd-python-skills-insane-search-scripts-youtube-tran
description: >
  Use when MyHarness sees this repeated verified failure pattern: cmd input=python
  .skills/insane-search/scripts/youtube_transcript.py
  "https://www.youtube.com/watch?v=ITT_5bPLEZw" --json --max-chars 200000 > .myharness/ui-
  che
---

# learned-cmd-python-skills-insane-search-scripts-youtube-tran

This skill was generated automatically from a repeated, verified MyHarness failure pattern.

## Generalization Rules
- Treat stored evidence as examples, not as the only trigger.
- Prefer reusable failure classes such as platform, tool, status code, file type, or workflow step over exact URLs, paths, prompts, or IDs.
- Reuse an existing helper script, skill, API route, or validator before assembling a new one-off command.
- If the verified work is only inspection and not a real corrective path, treat the lesson as low-confidence and diagnose first.

## When To Use
- Use when MyHarness sees this repeated verified failure pattern: cmd input=python .skills/insane-search/scripts/youtube_transcript.py "https://www.youtube.com/watch?v=ITT_5bPLEZw" --json --max-chars 200000 > .myharness/ui-che

## Process
1. Read `references/learned-patterns.md` for the concrete observed pattern.
2. Apply the verified corrective path before retrying the failed approach.
3. Keep new evidence concise and avoid storing raw transcripts or secrets.

## Recommended Next Step
- Start by applying the verified corrective path: Ran command python .skills/insane-search/scripts/youtube_transcript.py "https://www.youtube.com/watch?v=ITT_5bPLEZw" --json --max-chars 200000 --output .myharness/ui-checks [(출력 없음)]

## Avoid
- Do not repeat the failing command, tool input, or assumption without checking the verified fix first.
