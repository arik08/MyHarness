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

test("keeps the expanded todo checklist width stable while progress text wraps", async () => {
  const css = await readFile(new URL("../styles.css", import.meta.url), "utf8");
  const dock = css.match(/\.todo-checklist-dock\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const card = css.match(/\.composer-todo-card\s*{[\s\S]*?^}/m)?.[0] ?? "";
  const activityLine = css.match(/\.todo-activity-line\s*{[\s\S]*?^}/m)?.[0] ?? "";

  assert.match(dock, /width:\s*min\(560px,\s*100%\);/);
  assert.match(card, /width:\s*100%;/);
  assert.doesNotMatch(card, /width:\s*max-content;/);
  assert.match(activityLine, /overflow-wrap:\s*anywhere;/);
  assert.match(activityLine, /white-space:\s*normal;/);
  assert.match(activityLine, /word-break:\s*break-word;/);
});
