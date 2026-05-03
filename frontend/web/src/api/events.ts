import type { BackendEvent } from "../types/backend";

export type EventHandlers = {
  onEvent(event: BackendEvent): void;
  onError(error: Event): void;
};

export function openBackendEvents(params: URLSearchParams, handlers: EventHandlers): EventSource {
  const source = new EventSource(`/api/events?${params.toString()}`);

  source.onmessage = (message) => {
    try {
      handlers.onEvent(JSON.parse(message.data) as BackendEvent);
    } catch {
      handlers.onEvent({ type: "error", message: "이벤트를 해석하지 못했습니다." });
    }
  };

  source.onerror = (error) => {
    handlers.onError(error);
  };

  return source;
}
