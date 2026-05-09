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
