import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("aligns workflow child rails to the parent step and keeps previews full width", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");

  const workflowList = css.match(/\.workflow-list\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const childConnector = css.match(/\.workflow-step\.child::before\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const outputList = css.match(/\.workflow-output-list\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(workflowList, /--workflow-child-indent:\s*28px;/);
  assert.match(workflowList, /--workflow-parent-dot-center:\s*5px;/);
  assert.match(childConnector, /left:\s*calc\(var\(--workflow-parent-dot-center\) - var\(--workflow-child-indent\)\);/);
  assert.match(childConnector, /width:\s*calc\(var\(--workflow-child-indent\) - var\(--workflow-parent-dot-center\) - 5px\);/);
  assert.match(outputList, /margin:\s*10px 0 2px;/);
  assert.doesNotMatch(outputList, /margin:\s*10px 0 2px 30px;/);
});

test("keeps Claude theme activity status aligned with the neutral sidebar tone", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const activityStatus = css.match(/:root:not\(\[data-theme\]\) \.workflow-activity-status\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const activitySpinner = css.match(/:root:not\(\[data-theme\]\) \.workflow-activity-spinner\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(activityStatus, /var\(--sidebar-hover\)/);
  assert.match(activityStatus, /var\(--line-strong\)/);
  assert.doesNotMatch(activityStatus, /var\(--accent\)/);
  assert.match(activitySpinner, /var\(--icon-muted\)/);
  assert.doesNotMatch(activitySpinner, /var\(--accent\)/);
});

test("uses softer tinted workflow output previews for light-family themes", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const lightPreview = css.match(/:root:not\(\[data-theme\]\) \.workflow-output-preview\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const claudePreview = css.match(/:root\[data-theme="claude"\] \.workflow-output-preview\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(lightPreview, /background:\s*#f4f8fb;/);
  assert.match(lightPreview, /border-color:\s*#dbe7f1;/);
  assert.match(claudePreview, /background:\s*#f8f5f0;/);
  assert.doesNotMatch(css, /data-theme="posco"/);
  assert.match(css, /\.workflow-diff-line\.added\s*{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--success-soft\) 44%,\s*transparent\);/);
  assert.match(css, /\.workflow-diff-line\.removed\s*{[\s\S]*?background:\s*color-mix\(in srgb,\s*var\(--danger-soft\) 44%,\s*transparent\);/);
  assert.doesNotMatch(css, /:root\[data-theme="claude"\] \.workflow-output-body\s*{/);
});

test("caps inline Mermaid chart height while preserving scroll access", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const mermaidChart = css.match(/\.markdown-body \.mermaid-chart\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(mermaidChart, /max-height:\s*min\(640px,\s*68vh\);/);
  assert.match(mermaidChart, /overflow:\s*auto;/);
  assert.match(mermaidChart, /overscroll-behavior:\s*contain;/);
});

test("sizes Mermaid zoom viewer from the viewport instead of small fixed caps", async () => {
  const [css, markdownMessage, artifactPreview, server] = await Promise.all([
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("../src/components/MarkdownMessage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/components/ArtifactPreview.tsx", import.meta.url), "utf8"),
    readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  ]);
  const backdrop = css.match(/\.mermaid-zoom-backdrop\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const dialog = css.match(/\.mermaid-zoom-dialog\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(backdrop, /padding:\s*max\(12px,\s*2vmin\);/);
  assert.match(dialog, /width:\s*min\(1680px,\s*94vw\);/);
  assert.match(dialog, /height:\s*min\(1040px,\s*90vh\);/);
  assert.doesNotMatch(dialog, /1180px|820px/);
  for (const source of [markdownMessage, artifactPreview, server]) {
    assert.match(source, /Math\.max\(18,\s*Math\.min\(rect\.width,\s*rect\.height\) \* 0\.035\)/);
    assert.doesNotMatch(source, /const padding = 56;/);
  }
});
