import assert from "node:assert/strict";
import test from "node:test";

import {
  compareHistoryItems,
  historyOrderTimestamp,
  lastAssistantActivityTimestamp,
} from "../modules/historyOrder.js";

test("uses a stable file creation timestamp before modification time for legacy sessions", () => {
  const timestamp = historyOrderTimestamp(
    {},
    { birthtimeMs: 1_000, ctimeMs: 2_000, mtimeMs: 9_000 },
    10_000,
  );

  assert.equal(timestamp, 1_000);
});

test("keeps explicit session created_at as the primary history order", () => {
  const timestamp = historyOrderTimestamp(
    { created_at: 123 },
    { birthtimeMs: 1_000, mtimeMs: 9_000 },
    10_000,
  );

  assert.equal(timestamp, 123);
});

test("uses the latest assistant answer timestamp for history activity", () => {
  const timestamp = lastAssistantActivityTimestamp({
    history_events: [
      { type: "user", text: "질문", timestamp: 1_000 },
      { type: "assistant", text: "이전 답변", timestamp: 2_000 },
      { type: "assistant", text: "최근 답변", timestamp: 3_000 },
    ],
  });

  assert.equal(timestamp, 3_000_000);
});

test("sorts pinned sessions first, then assistant-active sessions, then created time", () => {
  const items = [
    { value: "new-user-only", createdAt: 4_000 },
    { value: "old-assistant", createdAt: 1_000, lastAssistantAt: 2_000 },
    { value: "pinned", createdAt: 1, pinned: true, description: "고정" },
    { value: "recent-assistant", createdAt: 500, lastAssistantAt: 3_000 },
  ];

  items.sort(compareHistoryItems);

  assert.deepEqual(items.map((item) => item.value), [
    "pinned",
    "recent-assistant",
    "old-assistant",
    "new-user-only",
  ]);
});
