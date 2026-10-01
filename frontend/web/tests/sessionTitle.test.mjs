import assert from "node:assert/strict";
import test from "node:test";
import { storedSessionTitle } from "../modules/sessionTitle.js";

const user = (text) => ({ role: "user", content: [{ type: "text", text }] });
const markers = [
  "[Compact boundary marker] token_count=5000",
  "[compact boundary...",
  "[Compact attachment: old input]",
  "[conversation summary] old history",
  "This session is being continued from earlier",
  "Session memory summary from earlier turns",
];

test("compaction and reload keep an established title", () => {
  for (const marker of markers) {
    assert.equal(storedSessionTitle({ summary: "Original project", messages: [user(marker), user("continue")] }), "Original project");
  }
});

test("legacy synthetic titles recover from authored history before reduced context", () => {
  for (const marker of markers) {
    assert.equal(storedSessionTitle({
      summary: marker, first_user_summary: marker,
      history_events: [{ type: "user", text: marker }, { type: "user", text: "Original request" }],
      messages: [user(marker), user("continue")],
    }), "Original request");
    assert.equal(storedSessionTitle({ messages: [user(marker)] }), "");
    assert.equal(storedSessionTitle({ messages: [user(marker), user("Real request")] }), "Real request");
  }
});

test("archive recovery and intentional user titles remain available", () => {
  assert.equal(storedSessionTitle({ summary: markers[0], tool_metadata: {
    user_input_archive: [{ text: "Original archived request" }],
  } }), "Original archived request");
  assert.equal(storedSessionTitle({ summary: markers[0], tool_metadata: {
    session_title_user_edited: true, session_title: "[compact boundary research]",
  } }), "[compact boundary research]");
});
