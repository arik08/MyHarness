---
name: learned-command-failures
description: Use when a shell command, test command, YouTube transcript command, or local skill tooling command fails repeatedly and the next step should diagnose the workflow instead of retrying the same command.
---

# Learned Command Failures

Automatically consolidated guidance from prior `learned-cmd-*` and shell failure skills.

## When To Use
- Repeated `cmd`, shell, npm/Vitest, Python helper, `yt-dlp`, or skill-creation failures.
- A command appears to run but only proves setup/output plumbing, not the underlying task.
- The successful path involved changing the helper, working directory, output route, or validation step.

## Core Lesson
- Do not memorize a historical command. Read the current failure, identify the mismatch, and switch to the stable workflow.
- Prefer project helpers over one-off shell pipelines.
- On this repo, invoke Python scripts with `python`.

## Quick Actions
| Situation | Do |
|---|---|
| React/Vitest failure | Run the narrow test, read the actual assertion failure, inspect the current component/test contract, then rerun the same narrow test. |
| YouTube transcript/subtitles | Use `.skills/insane-search/scripts/youtube_transcript.py`; use `--output` when saving is required and avoid PowerShell `>` redirection. |
| Local skill creation/editing | Run the project skill tooling, then validate the actual skill directory with `quick_validate.py`. |
| Generic shell failure | Check launcher, working directory, dependency, file path, and whether a reusable helper already exists. |

## Avoid
- Do not retry the exact command just because it appears in old evidence.
- Do not treat setup banners or partial stdout as the root cause.
- Do not open a historical file unless the current failure points to that file.
