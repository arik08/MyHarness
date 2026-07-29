# Product Requirements: dot-skill

## Goal

Turn structured and unstructured evidence about a person into a reusable AI skill that can reproduce useful working methods, communication patterns, and decision habits without pretending to be the real person.

## Users

- Knowledge workers who want to preserve a teammate's working context.
- Builders who want a persona grounded in public or private source material.
- Researchers who want a reusable thinking model for a public figure or fictional character.

## Core Requirements

1. Support `colleague`, `relationship`, and `celebrity` skill families.
2. Keep work patterns and persona patterns separate until final merge.
3. Store generated artifacts under `skills/{family}/{slug}`.
4. Preserve source provenance and confidence levels.
5. Keep generated output copyright-safe and evidence-bounded.
6. Provide reversible updates with version backups.

## Non-Goals

- Impersonating a real person for deception.
- Storing full private transcripts by default.
- Treating thin evidence as certain.
- Requiring a specific agent host.

## Success Criteria

- A user can generate a usable skill from a small but clear source set.
- The output clearly separates facts, inferred patterns, and unknowns.
- The generated skill can be installed into at least one host without manual restructuring.
