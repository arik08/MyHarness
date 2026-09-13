# Design Checklist

Use this checklist before final delivery of a visual HTML artifact.

## Content

- The first screen communicates the purpose immediately.
- Exact values are shown in tables or labels, not only visual marks.
- Every chart has a title, units, and readable labels.
- Every HTML chart that ECharts can render actually uses ECharts, including single simple charts and chart types also supported by Mermaid. Another renderer is used only for an identified requirement ECharts cannot provide; loading failures are disclosed rather than bypassed with substitute charts.
- Comparable values use a common unit and scale, bar baselines start at zero, and mark sizes reflect the actual data rather than arbitrary CSS dimensions.
- Charts render in the actual preview at normal and narrow widths, with exact values visible without hover; source inspection alone is not rendering verification.
- The artifact has a clear ending: conclusion, recommendation, next steps, or source notes.

## Layout

- No accidental horizontal scroll at desktop or mobile widths.
- Cards in the same row align consistently.
- Major sections have enough contrast without looking like unrelated templates.
- Dense information uses tables, small multiples, or grouped sections instead of giant cards.

## Style

- Palette is limited and purposeful.
- Typography uses a small scale: title, section heading, body, caption.
- No rendered text is below `14px`, including captions, sources, metadata, KPI labels, and tooltips. Keep page titles `36px`, section headings `24px`, body `16px`, and presentation body `20px` (`18px` only for a verified readable dense layout).
- Narrow screens, dense tables, and constrained iframe previews reflow or split content instead of shrinking text below the lower bounds.
- Chart-library, SVG, canvas, legend, and tooltip text follows the same lower bounds as equivalent HTML text.
- Borders/shadows are subtle.
- Radii are restrained unless a soft style was requested.

## Export

- Print/PDF styles preserve hierarchy and avoid awkward page breaks.
- Important content is visible without relying on hover, animation, or collapsed panels.
- Dark backgrounds print acceptably or switch to a print-safe theme.
