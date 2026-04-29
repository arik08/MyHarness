import assert from "node:assert/strict";
import test from "node:test";

import { mergeHistoryOptionsForRender } from "../modules/history.js";

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
