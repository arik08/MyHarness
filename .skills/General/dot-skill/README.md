# dot-skill

`dot-skill` is an English-first meta-skill for distilling source material about a person into a reusable AI skill. It can model a colleague's work habits, a relationship contact's communication style, or a public figure's decision framework.

## What It Creates

A generated skill typically includes:

- `SKILL.md`: the complete host-facing skill.
- `work.md`: domain knowledge, methods, standards, and workflows.
- `persona.md`: tone, communication style, boundaries, and behavioral rules.
- `meta.json`: structured metadata and evidence notes.
- `manifest.json`: install and compatibility metadata.

## Supported Families

| Family | Use case |
|---|---|
| `colleague` | Work style, engineering standards, product context, review habits. |
| `relationship` | Personal tone, shared memories, boundaries, emotional texture. |
| `celebrity` | Public figures, authors, creators, fictional characters, historical figures. |

## Supported Inputs

- Slack exports or API collection.
- Email `.eml` and `.mbox` archives.
- Markdown, text files, PDFs, screenshots, and document excerpts.
- Public web research with specific source URLs.
- User-provided notes and direct pasted text.

## Quick Start

In an agent host that supports local skills, invoke `dot-skill` and provide:

1. The character family.
2. The person's name or alias.
3. The role or relationship context.
4. Source material or a short description.
5. Any tone, boundary, or behavior constraints.

The skill will analyze the material, preview the result, and write a reusable generated skill after confirmation.

## Folder Layout

```text
dot-skill/
  SKILL.md
  prompts/
  references/
  tools/
  skills/
    colleague/
    relationship/
    celebrity/
```

Generated skills live under `skills/{family}/{slug}`.

## Design Principles

- Evidence first: distinguish observed facts from inference.
- English first: generated artifacts should be clean professional English by default.
- Copyright safe: store paraphrased notes, not long verbatim source passages.
- Reversible updates: back up generated skills before mutation.
- Host neutral: avoid hard-coded host paths unless installing into a specific host.
