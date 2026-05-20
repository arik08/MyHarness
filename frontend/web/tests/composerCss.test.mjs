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

test("keeps chat viewport height owned by the panel while messages handle scrolling", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const chatPanel = css.match(/\.chat-panel\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const messages = css.match(/\.messages\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const composer = css.match(/\.composer\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(chatPanel, /grid-template-rows:\s*58px minmax\(0,\s*1fr\);/);
  assert.match(chatPanel, /min-height:\s*0;/);
  assert.match(chatPanel, /overflow:\s*hidden;/);
  assert.match(messages, /min-height:\s*0;/);
  assert.match(messages, /overflow-y:\s*auto;/);
  assert.match(composer, /position:\s*absolute;/);
});
