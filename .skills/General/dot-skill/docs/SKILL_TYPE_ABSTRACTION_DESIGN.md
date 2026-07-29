# Skill Type Abstraction Design

## Overview

`dot-skill` uses a family abstraction to keep different person models consistent while allowing each family to define its own source strategy, analysis prompts, and storage root.

## Families

| Family | Primary emphasis |
|---|---|
| `colleague` | Workflows, standards, technical judgment, collaboration. |
| `relationship` | Tone, memory cues, boundaries, emotional context. |
| `celebrity` | Public evidence, mental models, decision frameworks, expression style. |

## Shared Artifacts

Each generated skill may include:

- `SKILL.md`
- `work.md`
- `persona.md`
- `work_skill.md`
- `persona_skill.md`
- `meta.json`
- `manifest.json`
- `versions/`
- `knowledge/`

## Confidence Model

Every meaningful behavior rule should be tagged mentally as one of:

- observed: directly supported by source material.
- inferred: plausible based on repeated patterns.
- user-specified: provided by the user.
- unknown: not enough evidence.

## Safety Boundaries

Generated skills should state that they are models based on source material. They should not claim to be the real person, reveal private information without consent, or fabricate sources.
