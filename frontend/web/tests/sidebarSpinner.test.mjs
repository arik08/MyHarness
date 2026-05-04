import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps the sidebar busy spinner vertically centered while rotating", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const keyframes = css.match(/@keyframes historyBusySpin\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(keyframes, /translateY\(-50%\)\s+rotate\(/);
});
