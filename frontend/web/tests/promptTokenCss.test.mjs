import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { resolve } from "node:path";

const css = readFileSync(resolve("styles.css"), "utf8");
const palette = readFileSync(resolve("src/styles/palette.css"), "utf8");

function cssBlock(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return css.match(new RegExp(`${escaped}\\s*{[\\s\\S]*?^}`, "m"))?.[0] ?? "";
}

function cssVar(block, name) {
  return block.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1]?.trim() || "";
}

test("light theme prompt tokens are visually distinct from the user message bubble", () => {
  const root = cssBlock(":root");
  function resolveColor(value, seen = new Set()) {
    return value.replace(/var\((--[\w-]+)\)/g, (_, name) => {
      assert.ok(!seen.has(name), `Circular color alias: ${name}`);
      const replacement = cssVar(root, name) || cssVar(palette, name);
      assert.ok(replacement, `Missing color alias: ${name}`);
      return resolveColor(replacement, new Set([...seen, name]));
    });
  }
  function rgb(value) {
    const resolved = resolveColor(value);
    if (/^#[\da-f]{6}$/i.test(resolved)) {
      return [1, 3, 5].map((offset) => parseInt(resolved.slice(offset, offset + 2), 16));
    }
    const mix = resolved.match(/^color-mix\(in srgb, (#[\da-f]{6}) (\d+)%, (#[\da-f]{6})\)$/i);
    assert.ok(mix, `Unsupported color: ${resolved}`);
    const weight = Number(mix[2]) / 100;
    return rgb(mix[1]).map((channel, index) => channel * weight + rgb(mix[3])[index] * (1 - weight));
  }
  const user = rgb(cssVar(root, "--user"));
  for (const kind of ["skill", "command"]) {
    const background = rgb(cssVar(root, `--${kind}-token-bg`));
    const ink = rgb(cssVar(root, `--${kind}-token-ink`));
    assert.notDeepEqual(background, user);
    assert.ok(ink.every((channel, index) => channel < background[index] - 40));
  }
});
