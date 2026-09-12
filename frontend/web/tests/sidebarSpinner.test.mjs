import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the sidebar busy spinner vertically centered while rotating", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const keyframes = css.match(/@keyframes historyBusySpin\s*{[\s\S]*?^}/m)?.[0] ?? "";

  // Grid/flex centers both history spinners; animation must not move them.
  assert.match(keyframes, /rotate\(0deg\)/);
  assert.match(keyframes, /rotate\(360deg\)/);
  assert.doesNotMatch(keyframes, /translate/);
});
