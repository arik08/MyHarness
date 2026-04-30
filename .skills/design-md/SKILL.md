---
name: design-md
description: >
  Use when the user asks for a report, HTML artifact, dashboard, page, UI, or visual
  document in the style, concept, visual language, or brand-inspired look of a company
  or product, such as "Apple concept", "Stripe style", "Notion-like", or Korean
  prompts like "애플 컨셉으로 보고서 만들어줘". This single skill routes to one matching
  DESIGN.md reference file instead of loading every brand design into context. Preserve
  the requested artifact type: a report should stay a dense report, not become a homepage
  or landing page just because the reference brand is web/marketing-oriented.
---

# design.md Router

Use this skill only as a lightweight router. Do not load every design file.

## Workflow

1. Identify the requested brand/company/product from the user's words.
   - Korean brand names count: "애플" means `apple`, "노션" means `notion`, "스트라이프" means `stripe`, "버셀/베르셀" means `vercel`.
   - If the user asks for a general style without a brand, choose the closest listed design and state the choice briefly.
2. Read `references/catalog.json` from this skill directory to find the closest slug.
3. Read only the matching file under `references/designs/<slug>.md`.
4. Use that DESIGN.md as visual guidance for the requested artifact.
5. If the request names multiple brands, read only those specific files and deliberately blend them.

## Artifact-type discipline

Design references describe visual language, not the required document structure. Before applying
the reference, classify the requested output:

- **Report / research brief / company analysis**: dense report structure first. Use title block,
  executive summary, methodology/sources, key findings, financial tables, charts, risk sections,
  timeline, footnotes, and appendix-style details as needed. Do not create a marketing homepage,
  nav bar, hero CTA, testimonial area, feature-card funnel, pricing section, or oversized splash
  hero unless the user explicitly asks for a website.
- **Dashboard / operating view**: compact controls, KPI grid, charts, tables, and status panels.
- **Landing / homepage / product site**: only use homepage patterns when the user asks for a site,
  landing page, product page, brand page, or marketing page.
- **Slide / one-pager / infographic**: use presentation rhythm, but keep the requested facts and
  evidence visible.

If the user says "use Apple design-md" or similar while asking for a report, borrow Apple's
restraint, typography, materials, spacing, and chart polish; keep the body information-dense and
report-like.

## Guardrails

- Treat these files as brand-inspired design references, not official brand systems.
- Do not copy logos, trademarks, product names, exact marketing copy, or protected imagery unless the user supplied those assets and has the right to use them.
- Apply the visual language to the user's content: typography, spacing, color mood, density, layout rhythm, buttons, panels, cards, and motion cues.
- Keep the output appropriate for the requested medium. Style tokens must not override the user's content format.
- For business reports, company analysis, investment notes, and research artifacts, default to compact editorial/report composition over homepage composition.
- If no suitable design exists, say so briefly and use the nearest available reference from the catalog.

## Resource Layout

- `references/catalog.json`: compact slug, file, and description index.
- `references/designs/*.md`: one downloaded DESIGN.md per brand.
