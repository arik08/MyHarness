import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the project file toolbar on one row until the panel is narrow", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const toolbar = css.match(/\.project-file-toolbar\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const controls = css.match(/\.project-file-controls\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const narrowContainer = css.match(/@container artifact-panel \(max-width:\s*700px\)\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(toolbar, /display:\s*grid;/);
  assert.match(toolbar, /grid-template-columns:\s*minmax\(92px,\s*1fr\) max-content;/);
  assert.match(controls, /flex-wrap:\s*nowrap;/);
  assert.match(narrowContainer, /\.project-file-controls\s*{[\s\S]*?flex-wrap:\s*wrap;/);
});
