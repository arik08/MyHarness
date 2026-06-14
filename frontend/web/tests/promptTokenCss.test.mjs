import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const css = readFileSync(resolve("styles.css"), "utf8");

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*{[\\s\\S]*?^}`, "m"))?.[0] ?? "";
}

function cssVar(block, name) {
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() || "";
}

test("light theme prompt tokens are visually distinct from the user message bubble", () => {
  const root = cssBlock(":root");

  assert.equal(cssVar(root, "--user"), "#edf2f7");
  assert.equal(cssVar(root, "--skill-token-bg"), "#efe6ff");
  assert.equal(cssVar(root, "--skill-token-ink"), "#6f3dc6");
  assert.equal(cssVar(root, "--skill-token-mark-bg"), "#7a4ed8");
  assert.notEqual(cssVar(root, "--skill-token-bg"), cssVar(root, "--user"));
});
