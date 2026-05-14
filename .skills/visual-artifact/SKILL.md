---
name: visual-artifact
description: Create polished single-file HTML visual artifacts such as visually rich reports, dashboards, infographics, one-pagers, slide-like webpages, visual summaries, comparison pages, timelines, and interactive previews. Use when the user asks for a beautiful/dynamic webpage-like output, HTML preview, visual report, presentation-style page, screenshot-ready artifact, PDF-ready page, business/research summary, or any reusable visual deliverable intended to be opened in a browser or captured into PPT/PDF. Preserve the requested artifact type; ordinary report-style HTML should remain a web-native scrolling report unless the user explicitly asks for a fixed page, A4, or slide format.
---

# Visual Artifact

Create browser-native visual deliverables that are polished enough to screenshot, present, print, or convert to PDF/PPT.

## Default output

- Prefer one self-contained `.html` file with inline CSS and JS.
- When the user asks for research, investigation, comparison, analysis, source review, or a similar information-gathering task followed by "write/create a report" and does not specify a format, treat the deliverable as an HTML web report. Explicit format requests such as PPT, PowerPoint, Markdown, PDF, DOCX, XLSX, plain text, or slides override this default.
- If the user describes report length in tokens, including Korean forms such as `5000~8000 토큰`, `10000 토큰 수준`, `15000~20000 토큰 이상`, or `30000토큰 수준`, treat the number as an approximate output-size target that should be checked, not merely a style cue. Use the target to plan content depth, but do not crowd the page with walls of prose, cramped tables, or repetitive cards just to hit a length. Preserve visual rhythm with section summaries, charts, callouts, and source notes.
- Use a short purpose-specific kebab-case filename, not `index.html`, unless the user explicitly asks for it or an existing app requires it.
- Keep dependencies minimal. Use no CDN when CSS/SVG is enough; use CDN libraries when they materially improve the result.
- Make the artifact readable in a constrained iframe and in a normal browser window.
- Do not include secrets or unsanitized user-provided HTML.

## Decide the artifact type

- **Executive/report page**: structured findings, tables, charts, recommendations, sources in a polished scrolling web report.
- **A4 landscape page report**: only when the user explicitly asks for A4 landscape, A4 가로, 가로형 A4, printable horizontal PDF, or a fixed-page report, use `html-a4-landscape-report` instead of the general scrolling report workflow.
- **Dashboard**: KPI cards, charts, filters/toggles if useful, data table.
- **Infographic/one-pager**: strong story flow, big numbers, compact sections, print/capture-ready layout.
- **Slide-like HTML**: 16:9 sections, keyboard or scroll navigation only if useful.
- **Diagram/timeline/comparison**: SVG, Mermaid, or HTML/CSS layouts depending on complexity.

## Report-first rule

When the user asks for analysis, research, company information, financial results, market review,
quarterly trends, sources, or a report:

- Make it read like a report, not like a company homepage.
- Start with report metadata and an executive summary, not a marketing hero with CTA buttons.
- Do not ask the user to choose a layout, style, or report archetype when they already asked for a report. Infer the best direction from the subject, audience, source material, and requested format, then proceed.
- For ordinary vertical HTML reports, use a web-native report composition: masthead, executive summary, strong section rhythm, visual anchors, charts, callouts, tables, footnotes, and a clear closing. It should feel designed, not like a plain document exported to HTML.
- Prefer well-composed section bands, tables, footnotes, callouts, and charts over oversized feature cards.
- Use brand/style references as surface treatment only: typography, spacing, material, color, chart
  finish, and tone.
- Avoid nav menus, sign-up buttons, pricing blocks, testimonials, "features" funnels, and generic
  landing-page conversion sections unless explicitly requested.
- Put exact numbers in tables and chart labels; use charts for trend cognition.
- For financial/company reports, include a compact source note area and make uncertainty explicit.

## Visual direction

- Choose a visual concept before writing CSS. Keep it business-appropriate, but vary the format to fit the subject instead of reusing the same card grid every time.
- Choose the archetype yourself. Do not pause to offer these as options unless the user explicitly asks for alternatives.
- Useful report archetypes include: editorial briefing, analytical dashboard-report, consulting memo, intelligence dossier, market map, timeline review, operating review, and executive decision note.
- Let the archetype change the composition: a market map may use broad comparison bands and quadrant visuals; a timeline review may use a strong chronology spine; an executive decision note may use a tight recommendation stack; an intelligence dossier may use compact evidence panels and source trails.
- Avoid defaulting to the same hero/KPI-card/three-section/table layout unless it is clearly the best fit for the content.

## Design bar

- Aim for “usable in a real meeting,” not merely “AI-generated.”
- Use restrained but visually intentional business styling: clear type scale, crisp spacing, meaningful hierarchy, a subject-appropriate palette, and enough contrast between sections to guide the eye.
- Restrained does not mean all-white, gray, or template-like. Give each report a coherent visual system with a few distinctive accents, chart colors, rules, tags, or background bands that match the topic.
- Avoid oversized radii, pill-heavy cards, excessive gradients, and bloated padding unless requested.
- Prefer 4–8px radius for panels/cards/buttons.
- Avoid arbitrary pastel flooding across large cards, quadrants, table cells, or sections just to label categories. This is a caution against noisy decoration, not a ban on color. For business reports, use color with intent: section bands, pale fills with crisp accents, chart marks, left/top borders, small tags, icons, or callouts. Use stronger color when it supports quantitative intensity, status severity, selected state, brand tone, or a deliberately infographic-style artifact.
- Use exact tables for exact values; use charts for trends, comparisons, proportions, timelines, or distributions.
- For report-like artifacts, actively consider restrained semantic icons for section markers, KPIs, risks, recommendations, and action items when they improve scanning. Keep icons small, consistent, and businesslike; avoid childish, toy-like, emoji-heavy, or purely decorative icon use. Do not force icons into every card or paragraph.
- Prefer this default color palette for charts, categorical accents, heat scales, and report highlights unless the user provides a brand palette or the artifact clearly needs another scheme: `#3288bd`, `#66c2a5`, `#e6f598`, `#d53e4f`, `#9e0142`, `#f46d43`, `#fdae61`, `#fee08b`, `#abdda4`, `#5e4fa2`. Use a few colors intentionally; avoid turning every section into a rainbow.
- For Mermaid process maps and dense diagrams, use semantic color groups so the reader can scan the system at a glance: blue for standards/requests/reports, teal for operations/market/planning, orange for investment/CAPEX/strategic decisions, red for risk/issues, and purple for governance/approval. Prefer pale fills with crisp colored borders and readable dark text; use stronger fills only for start/end, warnings, or key status nodes. In flowcharts, add `classDef` styles and assign classes by meaning instead of leaving all nodes the same color.
- Use accessible contrast and semantic HTML.

## Library choices

- **ECharts**: multi-chart business dashboards/reports.
- **Chart.js**: simple common charts.
- **Lucide or similar icon sets**: restrained semantic icons for reports, dashboards, and visual summaries.
- **SVG/CSS**: small bespoke static visuals, cards, fixed callouts, and simple timelines when Mermaid or ECharts would be heavier than the job.
- **Mermaid**: maintainable diagrams in the Mermaid.js family, not only flowcharts. Prefer Mermaid over hand-drawn SVG for structured diagrams when the visual type fits, because Mermaid is usually cleaner and easier to revise. In MyHarness chat or Markdown artifact previews, prefer fenced `mermaid` blocks for compact diagrams such as `flowchart`, `sequenceDiagram`, `classDiagram`, `stateDiagram`, `erDiagram`, `gantt`, `pie`, `journey`, `gitGraph`, `timeline`, `mindmap`, `quadrantChart`, and `sankey`. Choose the type that fits the content instead of defaulting to flowchart. Use `quadrantChart` freely for 2x2 prioritization/positioning and use `sankey` for flow/allocation diagrams; MyHarness validates Mermaid before writing human-facing HTML/Markdown artifacts so syntax errors can be fixed before preview. Avoid Mermaid keyword-like flowchart class names such as `end`; use names like `finish` or `done`. If a requirement diagram is the right choice, quote user-defined `id`/`text` values and use canonical enum casing so MyHarness can render it reliably. In standalone HTML artifacts, include Mermaid via CDN only when the artifact needs those diagram types.
- **Reveal.js**: full HTML slide decks.
- **Three.js/D3/Leaflet**: only when 3D, advanced data visualization, or maps are central.

## Workflow

1. Infer audience, output type, size target, reuse goal, and visual archetype. For report requests, choose the visual archetype yourself and proceed; ask only when missing information prevents the factual work or the requested output format is genuinely unclear.
2. Structure the content before styling: sections, data, charts, interactions, export needs.
3. Build the single HTML artifact with responsive CSS and print/capture considerations.
4. Include `@media print` for PDF-friendly output when the artifact is report-like or slide-like.
5. If the user wants screenshots/PDF, use the `playwright-capture` skill after creating the HTML.
6. For important or dense visuals, use the `visual-review` skill to inspect clipping, overflow, chart labels, and print layout.

## Capture-friendly conventions

- For presentation-style output, include a `.stage` or `.slide` layout with 16:9 ratio when appropriate.
- For A4 landscape HTML, use `html-a4-landscape-report`; treat it as a page-based slide deck with `section.page`, a Page Plan, density limits, and overflow QA.
- For reports, make A4/Letter print behavior explicit with sensible page breaks.
- Avoid content that depends on hover-only interactions for core meaning.
- Keep animations subtle and disable or simplify them for print.

## References

- Read `references/design-checklist.md` when polishing a high-stakes visual, report, dashboard, or presentation artifact.
