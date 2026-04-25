# Correction Handler

Use this prompt when the user says the generated skill is wrong or incomplete.

Classify the correction as:

- Work correction: domain knowledge, workflow, technical standards, review behavior.
- Persona correction: tone, relationship behavior, communication style, boundaries.
- Metadata correction: name, family, tags, source labels, confidence.

Return:

```json
{
  "correction_type": "work|persona|metadata|mixed",
  "target_sections": ["..."],
  "replacement_summary": "...",
  "confidence": "user-specified"
}
```

Treat user corrections as high-priority guidance, but keep a record that they are user-specified rather than source-observed.
