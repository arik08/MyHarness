import assert from "node:assert/strict";
import test from "node:test";

import { historyOrderTimestamp } from "../modules/historyOrder.js";

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
