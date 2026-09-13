import { describe, expect, it, vi } from "vitest";
import { openBackendEvents } from "../events";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onmessage: ((message: MessageEvent<string>) => void) | null = null;
  onerror: ((error: Event) => void) | null = null;
  url: string;

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  close() {
    return undefined;
  }
}

describe("openBackendEvents", () => {
  it("commits replay checkpoints without exposing them as chat events", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();
    const onCursor = vi.fn();
    const source = openBackendEvents(new URLSearchParams({ session: "s1", lastEventId: "400" }), {
      onEvent, onCursor, onError: vi.fn(),
    });
    source.onmessage?.({ data: '{"type":"stream_checkpoint"}', lastEventId: "9000" } as MessageEvent);
    expect(onEvent).not.toHaveBeenCalled();
    expect(onCursor).toHaveBeenCalledWith("9000");
    expect(source.url).toContain("lastEventId=400");
    source.onmessage?.({ data: "invalid", lastEventId: "9001" } as MessageEvent);
    expect(onCursor).toHaveBeenCalledTimes(1);
  });

  it("does not mislabel handler failures or advance past an undelivered event", () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn(() => { throw new Error("delivery failed"); });
    const onCursor = vi.fn();
    const source = openBackendEvents(new URLSearchParams(), { onEvent, onCursor, onError: vi.fn() });
    expect(() => source.onmessage?.({ data: '{"type":"line_complete"}', lastEventId: "10" } as MessageEvent)).toThrow("delivery failed");
    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onCursor).not.toHaveBeenCalled();
  });
  it("parses backend event messages", () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    const onEvent = vi.fn();

    openBackendEvents(new URLSearchParams({ sessionId: "s1" }), {
      onEvent,
      onError: vi.fn(),
    });

    FakeEventSource.instances[0].onmessage?.({
      data: JSON.stringify({ type: "assistant_delta", value: "안녕하세요" }),
    } as MessageEvent<string>);

    expect(onEvent).toHaveBeenCalledWith({ type: "assistant_delta", value: "안녕하세요" });
  });
});
