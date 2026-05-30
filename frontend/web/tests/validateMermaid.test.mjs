import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("Mermaid validator parses Gantt diagrams in Node", () => {
  const payload = {
    diagrams: [
      {
        index: 1,
        origin: "test",
        source: [
          "gantt",
          " title Sample report schedule",
          " dateFormat YYYY-MM-DD",
          " axisFormat %m/%d",
          " section Prep",
          " Requirements check :done, a1, 2026-05-27, 1d",
          " section Writing",
          " Mermaid validation :active, b1, 2026-05-28, 1d",
        ].join("\n"),
      },
    ],
  };

  const result = spawnSync(process.execPath, ["scripts/validate_mermaid.mjs"], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, errors: [] });
});
