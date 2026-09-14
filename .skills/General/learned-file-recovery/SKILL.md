---
name: learned-file-recovery
description: Diagnose file read, write, edit and generated artifact validation failures, including Mermaid preflight errors.
---

# Learned File Recovery

- Check the failing operation, resolved path, encoding and validator diagnostics before changing the file.
- When preflight rejects an artifact, repair the reported syntax or output contract and retry the same write or edit. Do not bypass validation or claim an unwritten file exists.
- Resolve validation helpers from the current installed skill. Verify the saved artifact through the relevant parser or renderer; unrelated commands do not establish recovery.

## Learning evidence
- Add new observations to this common failure-class skill, not a new skill per command, source, identifier or error message.
- Consult [recent patterns](references/learned-patterns.md) only for the current failure. Verify that the recorded correction actually applies before retrying.
- [Historical evidence](references/historical-evidence.md) preserves previous observations, including weak or unrelated claimed fixes. It is provenance, not an executable recovery procedure.
