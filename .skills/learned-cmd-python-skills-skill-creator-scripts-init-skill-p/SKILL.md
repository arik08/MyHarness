---
name: learned-cmd-python-skills-skill-creator-scripts-init-skill-p
description: >
  Use when creating or editing a local skill and the init command output is not
  enough to prove the skill is loadable.
---

# learned-cmd-python-skills-skill-creator-scripts-init-skill-p

Automatically learned guidance, generalized from prior skill-creation command checks.

## When To Use
- Use for local MyHarness skill creation, generated skill edits, or frontmatter/interface changes.

## Generalized Lesson
- Skill creation is not complete when the init command prints a success-looking line. The skill must be validated and, when practical, loaded by the registry.
- The exact historical skill name is only an example.

## Recommended Next Step
- Use the project skill tooling, then run the quick validator against the actual skill directory.
- Use `python` when invoking Python scripts in this repo.

## Avoid
- Do not edit generated skill YAML/frontmatter without validating it afterward.
