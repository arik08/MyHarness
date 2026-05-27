---
name: html-a4-landscape-report
description: Use when creating or revising A4 landscape reports in HTML or PPTX, printable horizontal PDF-ready reports, fixed-page one-pagers, or slide-deck-like artifacts where 297mm x 210mm pages, page plans, density limits, table splitting, and overflow checks matter.
---

# A4 Landscape Report

## Overview

A4 landscape 산출물은 긴 웹문서가 아니라 고정 크기 페이지로 만든 보고서형 slide deck이다. HTML과 PPTX 모두 이 스킬의 페이지 구조, 밀도, 반복 헤더, overflow QA 기준을 따른다. 콘텐츠를 한 페이지에 압축하지 말고, 페이지를 나누고 정보량을 제한한다.

## Use This Instead Of

- Use `visual-artifact` alone for long scrolling HTML reports, dashboards, infographics, microsites, and ordinary web reports.
- Use this skill together with `visual-artifact` for HTML/PDF/browser A4 landscape reports. `visual-artifact` owns visual direction; this skill owns page structure, density limits, table splitting, and overflow QA.
- Use this skill together with `pptx-writer` when the user asks for A4 landscape PPTX or PowerPoint. `pptx-writer` owns editable PPTX generation; this skill owns A4 page planning, density, repeated header placement, and visual QA expectations.

## Required Workflow

1. Create a Page Plan before writing HTML.
2. Generate one self-contained artifact: for HTML, independent `section.page` elements; for PPTX, A4 landscape slides with matching page boundaries.
3. Use only the allowed page layouts below unless the user explicitly provides a template.
4. Split content across pages whenever density limits would be exceeded.
5. Run rendered QA for clipping, overflow, table length, and print behavior before delivery.

## Page Plan

Before producing HTML or PPTX, decide:

| Field | Rule |
| --- | --- |
| Page count | Enough pages to avoid compression; do not force all content into one page. |
| Page title | Short, report-like title. |
| Header position | Keep chapter, title, and subtitle positions consistent across pages unless a cover or section divider intentionally breaks the pattern. |
| Key message | One sentence per page. |
| Layout type | One of the allowed layouts. |
| Content blocks | Maximum 3 blocks per page. |
| Data split | Tables over 8 rows or dense charts must be split. |

If the user did not ask to see the plan, keep it concise in your working notes and proceed.

## Allowed Layouts

| Layout | Use for | Density limit |
| --- | --- | --- |
| Cover | Title, subtitle, date, subject image or key visual | 1 title, 1 subtitle, 3 metadata items |
| Executive Summary | Top-level conclusion and 3-4 KPI/findings | 4 cards or fewer |
| Two Column Analysis | Current state vs implication, issue vs action | 2 columns, 2 blocks each |
| Table Focus | Decision table, comparison, risk register | 8 body rows per page |
| Chart Focus | One chart plus interpretation | 1 chart, 5 bullets or fewer |
| Roadmap / Timeline | Milestones, phases, migration plan | 5 phases or fewer |

Do not invent complex multi-panel layouts unless the page would still be readable at A4 print size.

## Density Rules

- Use one key message per page.
- Use at most 3 major blocks per page.
- Use at most 5 bullets per block and keep bullets short.
- Use at most 4 summary cards per page.
- Use table font sizes around 8-9pt and body text around 9.5-11pt.
- Split tables after 8 body rows instead of shrinking text.
- Prefer concise labels, callouts, and tables over long paragraphs.
- Keep repeated chapter, title, and subtitle positions consistent so the deck-like report scans cleanly page to page.
- Do not leave the lower body area visibly empty when useful evidence, notes, callouts, or secondary comparisons can fit without harming the design.
- Treat under-filled body height as a QA failure on normal content pages: fixed-height A4 pages should use the vertical space with meaningful information architecture, not stop halfway down the page.
- If content overflows, add a page; do not hide the overflow.
- If a page feels bottom-empty because there is not enough material, reduce the page count or choose a fuller allowed layout; do not add filler text.

## CSS Contract

For HTML output, use this structure as the default base. Adapt colors and typography, but keep the sizing model.

```css
@page {
  size: A4 landscape;
  margin: 0;
}

body {
  margin: 0;
  background: #e8ebef;
}

.sheet {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 16px 0;
}

section.page {
  width: 297mm;
  height: 210mm;
  box-sizing: border-box;
  padding: 14mm 16mm;
  background: #fff;
  break-after: page;
  display: grid;
  grid-template-rows: 18mm minmax(0, 1fr) 10mm;
  gap: 6mm;
  overflow: visible;
}

.page-header,
.page-footer {
  display: flex;
  justify-content: space-between;
  gap: 8mm;
}

.page-content {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 6mm;
  min-height: 0;
}

.block {
  min-width: 0;
  min-height: 0;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 8.5pt;
}

th,
td {
  padding: 1.8mm 2mm;
}

@media print {
  body {
    background: #fff;
  }

  .sheet {
    gap: 0;
    padding: 0;
  }

  section.page {
    box-shadow: none;
  }
}
```

Avoid `min-height: 100vh`, page `height: auto`, uncontrolled `flex-wrap`, scroll containers inside pages, excessive absolute positioning, and `overflow: hidden` used to conceal layout failures.

## PPTX Contract

For PPTX output, use this skill with `pptx-writer` and keep the same page plan:

- Use A4 landscape dimensions, approximately 11.69in x 8.27in or 297mm x 210mm.
- Treat each slide as one fixed A4 page, not as a generic widescreen deck slide.
- Preserve the same chapter, title, subtitle, source/footer, and page marker positions across comparable slides.
- Keep the lower body area meaningfully used when the material supports it, without adding filler or harming the design.
- Prefer editable text, tables, charts, and shapes; use images only when they are the right source asset or visual evidence.

## QA Checklist

- Each HTML page is an independent `section.page`; each PPTX slide is one A4 landscape page.
- Each page has header, content, and footer regions.
- Repeated chapter/title/subtitle headers stay in the same visual position across comparable pages.
- No `.page` has hidden overflow used as a mask.
- No page content exceeds the 297mm x 210mm page box in the rendered browser or PPTX preview.
- Normal content pages use most of the available body height with useful content structure; a half-empty body is a defect unless it is an intentional cover, divider, or breathing-space page.
- Lower body areas are not left conspicuously empty unless the page is a deliberate cover, divider, or visual breathing-space page.
- No table has more than 8 body rows on one page.
- No chart is cramped into a narrow card; chart containers have explicit dimensions.
- Print CSS uses `@page { size: A4 landscape; }`.
- Render in the Codex/MyHarness browser when available; otherwise run the visual review script with an A4-like viewport and inspect console errors, clipping, and horizontal overflow.
