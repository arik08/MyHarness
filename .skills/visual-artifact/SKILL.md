---
name: visual-artifact
description: Create polished single-file HTML visual artifacts such as dense reports, dashboards, infographics, one-pagers, slide-like webpages, visual summaries, comparison pages, timelines, and interactive previews. Use when the user asks for a beautiful/dynamic webpage-like output, HTML preview, visual report, presentation-style page, screenshot-ready artifact, PDF-ready page, business/research summary, or any reusable visual deliverable intended to be opened in a browser or captured into PPT/PDF. Preserve the requested artifact type; report-style HTML should not default to a homepage or landing page layout.
---

# Visual Artifact

Create browser-native visual deliverables that are polished enough to screenshot, present, print, or convert to PDF/PPT.

## Default output

- Prefer one self-contained `.html` file with inline CSS and JS.
- When the user asks for research, investigation, comparison, analysis, source review, or a similar information-gathering task followed by "write/create a report" and does not specify a format, treat the deliverable as an HTML web report. Explicit format requests such as PPT, PowerPoint, Markdown, PDF, DOCX, XLSX, plain text, or slides override this default.
- If the user describes report length in tokens, including Korean forms such as `5000~8000 토큰`, `10000 토큰 수준`, `15000~20000 토큰 이상`, or `30000토큰 수준`, treat the number as an approximate output-size target that should be checked, not merely a style cue. Use this scale: `5000~8000` tokens = short report, `10000` = medium report, `15000~20000` = long report, and `20000+` = very long deep report. For `30000 token level` or `30000토큰 수준`, target at least roughly `25000` estimated tokens of substantive report content unless a hard model/tool limit prevents it; estimate the final artifact size and expand before finishing if it is materially under the requested tier.
- Use a short purpose-specific kebab-case filename, not `index.html`, unless the user explicitly asks for it or an existing app requires it.
- Keep dependencies minimal. Use no CDN when CSS/SVG is enough; use CDN libraries when they materially improve the result.
- Make the artifact readable in a constrained iframe and in a normal browser window.
- Do not include secrets or unsanitized user-provided HTML.

## Decide the artifact type

- **Executive/report page**: structured findings, tables, charts, recommendations, sources.
- **Dashboard**: KPI cards, charts, filters/toggles if useful, data table.
- **Infographic/one-pager**: strong story flow, big numbers, compact sections, print/capture-ready layout.
- **Slide-like HTML**: 16:9 sections, keyboard or scroll navigation only if useful.
- **Diagram/timeline/comparison**: SVG, Mermaid, or HTML/CSS layouts depending on complexity.

## Report-first rule

When the user asks for analysis, research, company information, financial results, market review,
quarterly trends, sources, or a report:

- Make it read like a report, not like a company homepage.
- Start with report metadata and an executive summary, not a marketing hero with CTA buttons.
- Prefer dense section bands, tables, footnotes, callouts, and charts over oversized feature cards.
- Use brand/style references as surface treatment only: typography, spacing, material, color, chart
  finish, and tone.
- Avoid nav menus, sign-up buttons, pricing blocks, testimonials, "features" funnels, and generic
  landing-page conversion sections unless explicitly requested.
- Put exact numbers in tables and chart labels; use charts for trend cognition.
- For financial/company reports, include a compact source note area and make uncertainty explicit.

## Design bar

- Aim for “usable in a real meeting,” not merely “AI-generated.”
- Use restrained business styling: clear type scale, tight spacing, meaningful hierarchy, limited palette.
- Avoid oversized radii, pill-heavy cards, excessive gradients, and bloated padding unless requested.
- Prefer 4–8px radius for panels/cards/buttons.
- Avoid tinting large card, quadrant, table-cell, or section surfaces with different pastel semantic colors just to distinguish categories. This often looks childish, noisy, or like a heatmap without data. For business reports, keep most surfaces white/neutral and express category meaning with restrained accents: thin left/top borders, small tags, icons, headings, chart marks, or subtle section rules. If colored surfaces are necessary, pair a very pale fill with a stronger border or top/left accent so the fill stays quiet and the semantic color is carried by the edge, not the whole surface. Use large colored fills only when the color encodes real quantitative intensity, status severity, selected state, or a deliberately infographic-style artifact.
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

1. Infer audience, output type, size target, and reuse goal. Ask only if ambiguity risks the wrong artifact.
2. Structure the content before styling: sections, data, charts, interactions, export needs.
3. Build the single HTML artifact with responsive CSS and print/capture considerations.
4. Include `@media print` for PDF-friendly output when the artifact is report-like or slide-like.
5. If the user wants screenshots/PDF, use the `playwright-capture` skill after creating the HTML.
6. For important or dense visuals, use the `visual-review` skill to inspect clipping, overflow, chart labels, and print layout.

## Capture-friendly conventions

- For presentation-style output, include a `.stage` or `.slide` layout with 16:9 ratio when appropriate.
- For reports, make A4/Letter print behavior explicit with sensible page breaks.
- Avoid content that depends on hover-only interactions for core meaning.
- Keep animations subtle and disable or simplify them for print.

## References

- Read `references/design-checklist.md` when polishing a high-stakes visual, report, dashboard, or presentation artifact.
