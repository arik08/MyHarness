import { readFile } from "node:fs/promises";
import { test } from "node:test";
import assert from "node:assert/strict";

test("describes AI edit offsets as rendered text offsets with HTML and context guidance", async () => {
  const serverSource = await readFile(new URL("../server.mjs", import.meta.url), "utf8");

  assert.match(serverSource, /Rendered text offsets/i);
  assert.match(serverSource, /not raw HTML offsets/i);
  assert.match(serverSource, /Selected HTML/i);
  assert.match(serverSource, /Before context/i);
  assert.match(serverSource, /After context/i);
});
