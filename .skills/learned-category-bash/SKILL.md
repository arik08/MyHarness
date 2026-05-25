---
name: learned-category-bash
description: >
  Use when repeated shell command failures point to a workflow mismatch, not a
  command that should be retried verbatim.
---

# learned-category-bash

Automatically learned guidance, generalized from prior shell-command failures.

## When To Use
- Use for repeated shell or command-line failures where the successful path came from changing the workflow, data source, launcher, or validation route.

## Generalized Lesson
- Do not memorize the exact failing command. Identify why the shell path was wrong: wrong launcher, wrong working directory, missing dependency, blocked source, stale temporary file, or an analysis path that should use an API/source-specific helper.
- Prefer an existing reusable script, project command, or source-specific fetch path over rebuilding a one-off shell command.

## Recommended Next Step
- Re-check the goal and choose the stable workflow first. On this Windows repo, use `python` for Python scripts and project-provided helpers.
- If the prior evidence only shows that a different source was fetched successfully, treat it as a source-selection lesson rather than a shell syntax lesson.

## Avoid
- Do not rerun an exact temporary command just because it appeared in a learned evidence block.
