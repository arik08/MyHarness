---
name: learned-mcp-recovery
description: Diagnose MCP source routing, identifier validation, empty datasets, authentication and transport failures before retrying a data request.
---

# Learned MCP Recovery

- Read the owning MCP skill and current tool schema. Discover supported sources and identifiers through its catalog; never send another provider's source name or free-text query to an identifier field.
- For invalid identifiers, resolve the entity in the correct source and preserve required formatting, including leading zeros. For empty results, check available tables, periods and dimensions before concluding the data is absent.
- For service or authentication failures, check the returned diagnostics and configured connection. Retry only after a relevant condition changes; report unresolved access failures accurately.
- Loading a skill or passing a health check does not prove data retrieval succeeded. Re-run a representative data request and check returned records.

## Learning evidence
- Add new observations to this common failure-class skill, not a new skill per command, source, identifier or error message.
- Consult [recent patterns](references/learned-patterns.md) only for the current failure. Verify that the recorded correction actually applies before retrying.
- [Historical evidence](references/historical-evidence.md) preserves previous observations, including weak or unrelated claimed fixes. It is provenance, not an executable recovery procedure.
