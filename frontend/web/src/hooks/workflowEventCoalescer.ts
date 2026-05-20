import type { BackendEvent } from "../types/backend";

type ToolInputDeltaEvent = Extract<BackendEvent, { type: "tool_input_delta" }> & {
  tool_call_id?: string | null;
};

type CoalescerOptions = {
  flushMs?: number;
};

type PendingDelta = {
  order: number;
  event: ToolInputDeltaEvent;
};

const defaultFlushMs = 120;

function toolInputDeltaKey(event: ToolInputDeltaEvent) {
  const callId = typeof event.tool_call_id === "string" && event.tool_call_id ? event.tool_call_id : "";
  if (callId) {
    return `id:${callId}`;
  }
  const index = Number(event.tool_call_index);
  if (Number.isFinite(index)) {
    return `index:${index}`;
  }
  return `tool:${String(event.tool_name || "")}`;
}

function isToolInputDeltaEvent(event: BackendEvent): event is ToolInputDeltaEvent {
  return event.type === "tool_input_delta";
}

function mergeToolInputDelta(previous: ToolInputDeltaEvent, next: ToolInputDeltaEvent): ToolInputDeltaEvent {
  return {
    ...previous,
    ...next,
    tool_name: next.tool_name || previous.tool_name,
    tool_call_id: next.tool_call_id || previous.tool_call_id,
    tool_call_index: next.tool_call_index ?? previous.tool_call_index,
    arguments_delta: `${previous.arguments_delta || ""}${next.arguments_delta || ""}`,
  };
}

export function createWorkflowEventCoalescer(
  emit: (event: BackendEvent) => void,
  options: CoalescerOptions = {},
) {
  const flushMs = Math.max(0, options.flushMs ?? defaultFlushMs);
  const pending = new Map<string, PendingDelta>();
  let serial = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer === null) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  }

  function flush() {
    clearTimer();
    const entries = [...pending.values()].sort((left, right) => left.order - right.order);
    pending.clear();
    for (const entry of entries) {
      emit(entry.event);
    }
  }

  function scheduleFlush() {
    if (timer !== null) {
      return;
    }
    timer = setTimeout(flush, flushMs);
  }

  function push(event: BackendEvent) {
    if (!isToolInputDeltaEvent(event)) {
      flush();
      emit(event);
      return;
    }
    if (!event.arguments_delta) {
      return;
    }
    const key = toolInputDeltaKey(event);
    const current = pending.get(key);
    if (current) {
      pending.set(key, {
        ...current,
        event: mergeToolInputDelta(current.event, event),
      });
    } else {
      serial += 1;
      pending.set(key, { order: serial, event });
    }
    scheduleFlush();
  }

  return { push, flush };
}
