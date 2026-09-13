import assert from "node:assert/strict";
import test from "node:test";
import { createActivityLog } from "../modules/activityLog.js";

test("counts emitted lines per IP across sessions and resets at local midnight", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: new Date(2026, 8, 12, 23, 59, 59).getTime() });
  const lines = [];
  const log = createActivityLog((line) => lines.push(line));
  const a = { clientAddress: "192.168.0.8" };
  const b = { clientAddress: "192.168.0.9" };
  log.received(a);
  log.event(a, "assistant_delta");
  log.event(a, "line_complete");
  log.event(a, "line_complete");
  log.received({ ...a });
  log.received(b);
  assert.deepEqual(lines.map((line) => line.match(/\] \[(\d+)\]/)[1]), ["1", "2", "3", "1"]);
  t.mock.timers.tick(1000);
  log.received(a);
  log.event(b, "line_complete");
  assert.match(lines[4], /^\[00:00:00\] \[192\.168\.0\.8\] \[1\]/);
  assert.match(lines[5], /^\[00:00:00\] \[192\.168\.0\.9\] \[1\]/);
});

test("connections debounce reconnects, count tabs and keep different IPs independent", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const lines = [];
  const log = createActivityLog((line) => lines.push(line));
  const session = { clientAddress: "192.168.0.25", title: "보고서" };
  const closeFirst = log.connected(session);
  const closeTab = log.connected(session);
  const closeOtherIp = log.connected(session, "192.168.0.26");
  assert.equal(lines.length, 2);
  closeFirst();
  closeFirst();
  t.mock.timers.tick(5000);
  assert.equal(lines.length, 2);
  closeTab();
  t.mock.timers.tick(4000);
  const closeReconnect = log.connected(session);
  t.mock.timers.tick(2000);
  assert.equal(lines.length, 2);
  closeReconnect();
  closeOtherIp();
  session.title = "완성된 보고서";
  t.mock.timers.tick(5000);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /\[192\.168\.0\.25\] \[\d+\] 접속$/);
  assert.match(lines[2], /\[192\.168\.0\.25\] \[\d+\] 접속 종료$/);
  assert.match(lines[3], /\[192\.168\.0\.26\] \[\d+\] 접속 종료$/);
  const closeAgain = log.connected(session);
  assert.equal(lines.length, 5);
  closeAgain();
  t.mock.timers.tick(5000);
});

test("a message logs only receipt and one terminal event despite streaming noise", () => {
  const lines = [];
  const log = createActivityLog((line) => lines.push(line));
  const session = { id: "abcd1234-private", clientAddress: "192.168.0.25", title: "분기 보고서 작성", line: "secret message" };
  log.received(session);
  for (let i = 0; i < 100; i++) {
    for (const type of ["assistant_delta", "tool_progress", "status", "assistant_complete"]) log.event(session, type);
  }
  log.event(session, "line_complete");
  log.event(session, "line_complete");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^\[\d{2}:\d{2}:\d{2}\] \[192\.168\.0\.25\] \[\d+\] \[분기 보고서 작성\] 메시지 접수$/);
  assert.match(lines[1], /^\[\d{2}:\d{2}:\d{2}\] \[192\.168\.0\.25\] \[\d+\] \[분기 보고서 작성\] 응답 완료$/);
  assert.ok(lines.every((line) => !line.includes("secret") && !line.includes("private")));
});

test("logs the current title after it is generated and keeps IPv6 intact", () => {
  const lines = [];
  const log = createActivityLog((line) => lines.push(line));
  const session = { clientAddress: "2001:db8::25", title: "" };
  log.received(session);
  session.title = "분기 보고서 작성";
  log.event(session, "line_complete");
  assert.match(lines[0], /\[2001:db8::25\] \[\d+\] \[새 대화\] 메시지 접수$/);
  assert.match(lines[1], /\[2001:db8::25\] \[\d+\] \[분기 보고서 작성\] 응답 완료$/);
});

test("missing or malformed IP and control characters cannot create extra log lines", () => {
  const lines = [];
  const log = createActivityLog((line) => lines.push(line));
  log.received({});
  log.received({ clientAddress: "invalid\naddress", title: "보고서\r\n작성\u001b" });
  assert.match(lines[0], /\[확인 불가\] \[\d+\] \[새 대화\] 메시지 접수$/);
  assert.match(lines[1], /\[확인 불가\] \[\d+\] \[보고서 작성\] 메시지 접수$/);
  assert.ok(lines.every((line) => !/[\r\n\u001b]/.test(line)));
});

test("errors and cancellation do not subsequently claim completion; sessions stay independent", () => {
  const lines = [];
  const log = createActivityLog((line) => lines.push(line));
  const a = { id: "a" }, b = { id: "b" };
  log.event(a, "line_complete");
  log.received(a);
  log.received(b);
  log.event(a, "error");
  log.event(a, "line_complete");
  log.event(b, "cancel");
  log.event(b, "line_complete");
  assert.equal(lines.length, 4);
  assert.match(lines[2], /응답 오류/);
  assert.match(lines[3], /중단 요청 접수/);
  log.received(a);
  log.event(a, "line_complete");
  assert.match(lines.at(-1), /응답 완료/);
});
