import assert from "node:assert/strict";
import test from "node:test";
import { isNoisyBackendLogLine, normalizeBackendLogLine } from "../modules/backendLogNoise.js";

test("filters Rich-formatted successful MCP request diagnostics", () => {
  const header = "\u001b[2;36m[07/29/26 21:25:41]\u001b[0m \u001b[2;36mINFO\u001b[0m Processing request of type server.py:625";
  const request = "\u001b[2;36mListResourcesRequest\u001b[0m";

  assert.equal(normalizeBackendLogLine(header), "[07/29/26 21:25:41] INFO Processing request of type server.py:625");
  assert.equal(isNoisyBackendLogLine(header), true);
  assert.equal(isNoisyBackendLogLine(request), true);
  assert.equal(isNoisyBackendLogLine("ListResourcesRequest INFO"), true);
  assert.equal(isNoisyBackendLogLine("Processing request of type server.py:625"), true);
});

test("keeps warnings and errors visible", () => {
  assert.equal(isNoisyBackendLogLine("WARNING MCP server disconnected"), false);
  assert.equal(isNoisyBackendLogLine("ERROR ListResourcesRequest failed"), false);
});

test("filters wrapped source locations and arbitrary MCP request names", () => {
  for (const line of [":", "733         CallToolRequest", ": 733 CallToolRequest", "server.py:", "912 NewProtocolRequest", "\u001b[2m: 733\u001b[0m CallToolRequest"]) {
    assert.equal(isNoisyBackendLogLine(line), true, line);
  }
  for (const line of ["733", "Result: 733", "ERROR : 733 CallToolRequest", "WARNING NewProtocolRequest failed", "CallToolRequest failed"]) {
    assert.equal(isNoisyBackendLogLine(line), false, line);
  }
});
