import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the project file toolbar on one row until the panel is narrow", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const viewerList = css.match(/\.artifact-viewer:has\(\.project-file-toolbar\)\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const toolbar = css.match(/\.project-file-toolbar\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const controls = css.match(/\.project-file-controls\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const narrowContainer = css.match(/@container artifact-panel \(max-width:\s*600px\)\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(viewerList, /padding-top:\s*0;/);
  assert.match(toolbar, /display:\s*grid;/);
  assert.match(toolbar, /grid-template-columns:\s*minmax\(0,\s*1fr\);/);
  assert.match(toolbar, /margin:\s*0 -14px 8px;/);
  assert.doesNotMatch(css, /project-file-sort-summary/);
  assert.match(controls, /justify-content:\s*flex-start;/);
  assert.match(controls, /justify-self:\s*stretch;/);
  assert.match(controls, /flex-wrap:\s*nowrap;/);
  assert.match(narrowContainer, /\.project-file-controls\s*{[\s\S]*?flex-wrap:\s*wrap;/);
});
