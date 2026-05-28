import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const css = readFileSync(resolve("styles.css"), "utf8");

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*{[\\s\\S]*?^}`, "m"))?.[0] ?? "";
}

test("runtime profile mark ink follows dark and monochrome sidebar backgrounds", () => {
  const profileMark = cssBlock(".profile-mark");
  const darkTheme = cssBlock(':root[data-theme="dark"]');
  const monoTheme = cssBlock(':root[data-theme="mono"]');
  const monoOrangeTheme = cssBlock(':root[data-theme="mono-orange"]');

  assert.match(profileMark, /color:\s*var\(--profile-mark-ink\)/);
  assert.match(darkTheme, /--profile-mark-ink:\s*var\(--sidebar\)/);
  assert.match(monoTheme, /--profile-mark-ink:\s*var\(--sidebar\)/);
  assert.match(monoOrangeTheme, /--profile-mark-ink:\s*var\(--sidebar\)/);
});
