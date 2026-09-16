# UI colors

`palette.css` is the shared named palette, based on Lumina's cobalt and gray colors.
Change a palette entry here instead of copying a hex value into a component.

Use semantic CSS variables from `styles.css` in application UI:

| Purpose | Variable |
| --- | --- |
| Primary actions, links, selected state | `--accent`, `--accent-soft` |
| Connecting, waiting, warnings, cost notices | `--warning`, `--warning-soft` |
| Completion and success | `--success`, `--success-soft` |
| Errors and destructive actions | `--danger`, `--danger-soft` |
| Text and supporting text | `--ink`, `--muted`, `--faint` |
| Surfaces and borders | `--panel`, `--sidebar`, `--line`, `--line-strong` |

Derive tinted backgrounds and borders with `color-mix`; do not introduce separate
yellow or brown warning values per component or theme. File categories use the
named violet, teal, rose, and semantic colors. Question cards share the same palette.
The HTML preview's injected selection UI imports the palette as inline CSS because
iframe documents do not inherit the app's variables. User artifact content and
third-party syntax themes retain their own colors.
