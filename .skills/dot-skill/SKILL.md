---
name: dot-skill
description: "English-first meta-skill for turning source material about a person into a reusable AI skill."
argument-hint: "[character] [name-or-slug]"
version: "1.0.0"
user-invocable: true
allowed-tools: Read, Write, Edit, Bash
---

# dot-skill

Use this skill when the user wants to create, update, inspect, or install a person-based skill. The person may be a colleague, relationship contact, public figure, fictional character, or the user themselves.

Always operate in English unless the user explicitly asks for another language. Generated files, metadata, prompts, and summaries should default to clear professional English.

## Execution Root

Run all shell commands from the directory that contains this `SKILL.md`. Paths such as `tools/...`, `prompts/...`, `references/...`, and `skills/...` are relative to this skill root. Do not guess host-specific install paths.

## Supported Families

Ask the user which family they want if it is not obvious:

1. `colleague`: work habits, technical standards, delivery style, communication patterns.
2. `relationship`: personal tone, shared history, boundaries, memory cues.
3. `celebrity`: public figure, creator, author, leader, fictional character, or historical figure.

For celebrity skills, ask whether the user wants:

- `budget-friendly`: practical research with available sources.
- `budget-unfriendly`: deeper research, audit, synthesis, and validation.

## Workflow

1. Intake: read the relevant intake prompt for the selected family.
2. Collect material: use files, pasted text, Slack exports, email archives, Markdown, PDFs, screenshots, web research, or user notes.
3. Analyze work patterns with `prompts/work_analyzer.md`.
4. Analyze persona patterns with the family-specific persona analyzer.
5. Build `work.md` and `persona.md` from the builder prompts.
6. Preview a concise summary for the user and ask for confirmation.
7. Write the generated skill with `tools/skill_writer.py` rather than manually constructing the final tree.
8. For celebrity skills, run `tools/research/quality_check.py` before declaring the result complete.

## Source Collection Options

Prefer neutral, globally common sources:

- Slack exports or Slack API collection with `tools/slack_auto_collector.py`.
- Email `.eml` or `.mbox` files with `tools/email_parser.py`.
- Local Markdown, text, PDF, screenshots, and documents via the host's file reading tools.
- Public web research for public figures, using specific source URLs and copyright-safe paraphrases.
- Direct pasted notes from the user.

Do not invent sources, quotes, links, or credentials. When evidence is thin, label the resulting behavior as inferred or low-confidence.

## Prompt Matrix

| Family | Intake | Persona analyzer | Persona builder | Merger | Storage root |
|---|---|---|---|---|---|
| `colleague` | `prompts/intake.md` | `prompts/persona_analyzer.md` | `prompts/persona_builder.md` | `prompts/merger.md` | `skills/colleague/{slug}` |
| `relationship` | `prompts/relationship/intake.md` | `prompts/relationship/persona_analyzer.md` | `prompts/relationship/persona_builder.md` | `prompts/relationship/merger.md` | `skills/relationship/{slug}` |
| `celebrity` | `prompts/celebrity/intake.md` | `prompts/celebrity/persona_analyzer.md` | `prompts/celebrity/persona_builder.md` | `prompts/celebrity/merger.md` | `skills/celebrity/{slug}` |

Shared prompts:

- Work analyzer: `prompts/work_analyzer.md`
- Work builder: `prompts/work_builder.md`
- Correction handler: `prompts/correction_handler.md`

## Write Files

After confirmation, create temporary `meta`, `work`, and `persona` files, then run:

```bash
python3 tools/skill_writer.py \
  --action create \
  --character {character} \
  --slug {slug} \
  --name "{display_name}" \
  --meta /tmp/dot_skill_{slug}_meta.json \
  --work /tmp/dot_skill_{slug}_work.md \
  --persona /tmp/dot_skill_{slug}_persona.md \
  --base-dir skills/{character}
```

Use host install flags only when the user asks to install the generated skill into a specific host.

## Update Existing Skills

For new evidence or corrections:

1. Read the existing `work.md`, `persona.md`, and `meta.json`.
2. Use the family merger prompt or `prompts/correction_handler.md`.
3. Back up the current version with `tools/version_manager.py`.
4. Update through `tools/skill_writer.py --action update`.

Never silently overwrite a generated skill without preserving the previous version.
