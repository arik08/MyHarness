import { expect, it, vi } from "vitest";
import { loadHistorySnapshot } from "../history";
import { getJson } from "../http";

vi.mock("../http", () => ({ getJson: vi.fn(), postJson: vi.fn(), deleteJson: vi.fn() }));

it("shares in-flight snapshots but refetches when revisiting a conversation", async () => {
  let finish!: (value: unknown) => void;
  vi.mocked(getJson).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
  const first = loadHistorySnapshot({ sessionId: "changing-chat" });
  expect(loadHistorySnapshot({ sessionId: "changing-chat" })).toBe(first);
  finish({ type: "history_snapshot", message: "부분 응답" });
  await first;
  vi.mocked(getJson).mockResolvedValueOnce({ type: "history_snapshot", message: "완료된 응답" });
  expect((await loadHistorySnapshot({ sessionId: "changing-chat" })).message).toBe("완료된 응답");
  expect(getJson).toHaveBeenCalledTimes(2);
});
