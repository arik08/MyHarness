# Portable visual validation

- Observed failure class: a visual-check command referenced a developer-specific absolute path or a temporary script absent from another checkout.
- Diagnose the original error before retrying; a later successful command alone does not establish a fix.
- Resolve the MyHarness installation root from the active skill location. Confirm `.skills/General/visual-review/scripts/check_render.py` exists there, inspect its current CLI, and pass the actual artifact path.
- Do not reuse historical output filenames, sanitized user paths, partial flags, or `.myharness/ui-checks` scripts as dependencies.
- If the helper is unavailable, report the missing dependency and use an available validator; do not invent a successful check.
