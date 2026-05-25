import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("colors the settings admin shortcut blue when admin mode is active", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const activeShortcut = css.match(/\.modal-card \.settings-admin-shortcut\.active\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(activeShortcut, /color:\s*#2563eb;/);
});
