import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("centers single-line composer text within the input height", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const composerTextarea = css.match(/\.composer textarea\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(composerTextarea, /min-height:\s*28px;/);
  assert.match(composerTextarea, /padding:\s*4px 0;/);
  assert.match(composerTextarea, /line-height:\s*20px;/);
});
