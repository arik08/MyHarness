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
