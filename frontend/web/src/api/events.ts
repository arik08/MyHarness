import type { BackendEvent } from "../types/backend";

export type EventHandlers = {
  onEvent(event: BackendEvent): void;
  onError(error: Event): void;
  onCursor?(lastEventId: string): void;
};

export function openBackendEvents(params: URLSearchParams, handlers: EventHandlers): EventSource {
  const source = new EventSource(`/api/events?${params.toString()}`);

  source.onmessage = (message) => {
    let event: BackendEvent | { type: "stream_checkpoint" };
    try {
      event = JSON.parse(message.data);
    } catch {
      handlers.onEvent({ type: "error", message: "이벤트를 해석하지 못했습니다." });
      return;
    }
    if (event.type !== "stream_checkpoint") handlers.onEvent(event);
    // Advance only after delivery; recovery must never skip an unhandled event.
    if (message.lastEventId) handlers.onCursor?.(message.lastEventId);
  };

  source.onerror = (error) => {
    handlers.onError(error);
  };

  return source;
}
