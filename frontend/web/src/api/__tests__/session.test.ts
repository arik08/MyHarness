import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { capacityQueueStatusEvent, startSession } from "../session";

describe("startSession capacity queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("reports its position and resolves automatically when the queued session starts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "waiting", queueId: "queue-1", position: 2, message: "접속 대기열 2번째" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ status: "ready", sessionId: "session-ready", workspace: { name: "Default", path: "C:/demo" } }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const updates: Array<Record<string, unknown>> = [];
    const handleUpdate = (event: Event) => {
      updates.push((event as CustomEvent<Record<string, unknown>>).detail);
    };
    window.addEventListener(capacityQueueStatusEvent, handleUpdate);

    const pending = startSession({ clientId: "browser-1" });
    await vi.advanceTimersByTimeAsync(500);
    const session = await pending;
    window.removeEventListener(capacityQueueStatusEvent, handleUpdate);

    expect(session.sessionId).toBe("session-ready");
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/session/queue?queueId=queue-1&clientId=browser-1", {
      headers: { Accept: "application/json" },
    });
    expect(updates).toEqual([
      expect.objectContaining({ kind: "session", status: "waiting", position: 2 }),
      expect.objectContaining({ kind: "session", status: "started", position: 0 }),
    ]);
  });
});
