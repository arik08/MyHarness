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
  const poscoPreview = css.match(/:root\[data-theme="posco"\] \.workflow-output-preview\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(lightPreview, /background:\s*#f8fafc;/);
  assert.match(claudePreview, /background:\s*#f8f5f0;/);
  assert.match(poscoPreview, /background:\s*#f3f8fd;/);
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
