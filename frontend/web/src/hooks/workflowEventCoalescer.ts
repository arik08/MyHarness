import type { BackendEvent } from "../types/backend";
import { toolCallKey } from "../../modules/toolIdentity.js";

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
  let assistantWindow = false;
  let assistantDelta = "";

  function clearTimer() {
    if (timer === null) {
      return;
    }
    clearTimeout(timer);
    timer = null;
  }

  function flush() {
    clearTimer();
    assistantWindow = false;
    const text = assistantDelta;
    assistantDelta = "";
    if (text) emit({ type: "assistant_delta", message: text });
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
    if (event.type === "assistant_delta") {
      if (event.snapshot) {
        flush();
        emit(event);
        return;
      }
      const text = String(event.message ?? event.value ?? "");
      if (!text) return;
      if (pending.size) flush();
      if (!assistantWindow) {
        // Keep the first token immediate; batch the burst behind it on a fixed
        // timer so a long transcript does not re-render once per network chunk.
        assistantWindow = true;
        emit(event);
      } else {
        assistantDelta += text;
      }
      scheduleFlush();
      return;
    }
    if (assistantWindow) flush();
    if (!isToolInputDeltaEvent(event)) {
      flush();
      emit(event);
      return;
    }
    if (!event.arguments_delta) {
      return;
    }
    const key = toolCallKey(event);
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
