import assert from "node:assert/strict";
import test from "node:test";

import { formatHistoryTitle, mergeHistoryOptionsForRender } from "../modules/history.js";

test("keeps saved history items in their existing order when a saved chat is live", () => {
  const savedOptions = [
    { value: "older", label: "Older saved chat" },
    { value: "active", label: "Active saved chat" },
    { value: "newer", label: "Newer saved chat" },
  ];
  const liveOptions = [
    {
      value: "live:slot-active",
      liveSlotId: "slot-active",
      savedSessionId: "active",
      label: "Active live chat",
    },
    {
      value: "live:draft",
      liveSlotId: "draft",
      label: "New draft",
    },
  ];

  const merged = mergeHistoryOptionsForRender(savedOptions, liveOptions);

  assert.deepEqual(
    merged.map((option) => option.value),
    ["older", "live:slot-active", "newer", "live:draft"],
  );
  assert.equal(merged[1].label, "Active live chat");
});

test("formats history titles compactly for the sidebar", () => {
  const title = formatHistoryTitle("5/4 10:00 24 msg chat history 대화 제목을 짧게 나오게 해줘. 가급적 좌측 사이드바 안에 맞는 수준의 폭으로");

  assert.equal(title, "chat history 대화 제목을 짧게 나오게...");
  assert.ok(title.length <= 29);
});
