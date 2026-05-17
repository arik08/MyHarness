import { useEffect, useLayoutEffect, useRef } from "react";
import type { Dispatch } from "react";
import type { AppAction } from "../state/reducer";
import type { AppState, ChatMessage } from "../types/ui";

const nearBottomPx = 96;
const streamingRejoinBottomPx = 260;
const scrollStorageKey = "myharness:scrollPositions";
const maxStreamFollowLeadPx = 360;
export const messageBottomFollowEvent = "myharness:followMessageBottom";

function easeInOutCubic(progress: number) {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}

function readScrollPositions() {
  try {
    return JSON.parse(localStorage.getItem(scrollStorageKey) || sessionStorage.getItem(scrollStorageKey) || "{}") as Record<string, unknown>;
  } catch {
    try {
      return JSON.parse(sessionStorage.getItem(scrollStorageKey) || "{}") as Record<string, unknown>;
    } catch {
      return {};
    }
  }
}

function saveScrollPosition(sessionId: string | null | undefined, scrollTop: number) {
  if (!sessionId) {
    return;
  }
  const positions = readScrollPositions();
  positions[sessionId] = scrollTop;
  try {
    localStorage.setItem(scrollStorageKey, JSON.stringify(positions));
  } catch {
    // Embedded or private browsing contexts can block localStorage.
    try {
      sessionStorage.setItem(scrollStorageKey, JSON.stringify(positions));
    } catch {
      // Embedded or private browsing contexts can block all web storage.
    }
  }
}

function restoredScrollPosition(sessionId: string | null | undefined) {
  if (!sessionId) {
    return null;
  }
  const value = readScrollPositions()[sessionId];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function useMessageAutoFollow({
  state,
  dispatch,
  lastMessage,
  activeWorkflowFollowSignature,
}: {
  state: AppState;
  dispatch: Dispatch<AppAction>;
  lastMessage?: ChatMessage;
  activeWorkflowFollowSignature: string;
}) {
  const messagesRef = useRef<HTMLElement | null>(null);
  const autoFollowRef = useRef(true);
  const animationFrameRef = useRef(0);
  const tailFollowActiveRef = useRef(false);
  const autoScrollUntilRef = useRef(0);
  const userScrollIntentUntilRef = useRef(0);
  const scrollSaveTimerRef = useRef(0);
  const wasLastAssistantStreamingRef = useRef(false);
  const wasActiveWorkflowGrowingRef = useRef(false);
  const wasRestoringHistoryRef = useRef(state.restoringHistory);
  const streamScrollDurationMsRef = useRef(state.appSettings.streamScrollDurationMs);
  const streamFollowLeadPxRef = useRef(0);
  const isLastAssistantStreaming = state.busy && lastMessage?.role === "assistant" && !lastMessage.isComplete;
  const isActiveWorkflowGrowing = state.busy && Boolean(state.workflowAnchorMessageId && state.workflowEvents.length);
  const shouldFollowGrowingTail = isLastAssistantStreaming || isActiveWorkflowGrowing;
  const scrollSessionId = state.activeHistoryId || state.sessionId;
  const streamFollowLeadPx = Math.max(0, Math.min(maxStreamFollowLeadPx, state.appSettings.streamFollowLeadPx));

  streamScrollDurationMsRef.current = Math.max(0, Number(state.appSettings.streamScrollDurationMs));
  streamFollowLeadPxRef.current = streamFollowLeadPx;

  function stopAutoFollow(container = messagesRef.current) {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }
    tailFollowActiveRef.current = false;
    autoFollowRef.current = false;
    autoScrollUntilRef.current = 0;
    container?.classList.remove("streaming-follow");
  }

  function saveCurrentScrollPosition() {
    if (!state.restoringHistory) {
      saveScrollPosition(scrollSessionId, messagesRef.current?.scrollTop ?? 0);
    }
  }

  function scheduleScrollPositionSave() {
    window.clearTimeout(scrollSaveTimerRef.current);
    scrollSaveTimerRef.current = window.setTimeout(saveCurrentScrollPosition, 120);
  }

  function scrollMessagesToBottom(options: { smooth?: boolean; duration?: number; continuous?: boolean } = {}) {
    const container = messagesRef.current;
    if (!container) {
      return;
    }
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    const smooth = options.smooth && !reduceMotion;
    const continuous = Boolean(options.continuous);
    const duration = Math.max(0, Number(options.duration ?? streamScrollDurationMsRef.current));

    if (!smooth || duration <= 0) {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = 0;
      }
      tailFollowActiveRef.current = false;
      container.scrollTop = container.scrollHeight;
      container.dataset.lastScrollTop = String(container.scrollTop);
      return;
    }

    if (continuous && tailFollowActiveRef.current && animationFrameRef.current) {
      const settleMs = Math.max(140, Math.min(520, streamScrollDurationMsRef.current * 0.35));
      autoScrollUntilRef.current = Date.now() + duration + settleMs;
      return;
    }

    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    tailFollowActiveRef.current = continuous;
    const start = container.scrollTop;
    const startedAt = performance.now();
    let previousFrameAt = startedAt;
    let bufferedTarget = continuous
      ? Math.max(start, container.scrollHeight - container.clientHeight)
      : start;
    let followVelocity = 0;
    let lastRawTarget = bufferedTarget;
    let targetStableMs = 0;
    const settleMs = Math.max(140, Math.min(520, duration * 0.35));
    autoScrollUntilRef.current = Date.now() + duration + settleMs;

    const step = (now: number) => {
      if (!messagesRef.current) {
        animationFrameRef.current = 0;
        return;
      }
      const liveContainer = messagesRef.current;
      if (continuous) {
        const rawTarget = Math.max(0, liveContainer.scrollHeight - liveContainer.clientHeight);
        const elapsed = Math.min(64, Math.max(0, now - previousFrameAt));
        previousFrameAt = now;
        if (Math.abs(rawTarget - lastRawTarget) > 0.5) {
          lastRawTarget = rawTarget;
          targetStableMs = 0;
        } else {
          targetStableMs += elapsed;
        }
        const liveDuration = Math.max(1, streamScrollDurationMsRef.current);
        const liveLeadPx = Math.max(0, Math.min(maxStreamFollowLeadPx, streamFollowLeadPxRef.current));
        const leadRatio = liveLeadPx / maxStreamFollowLeadPx;
        const targetMs = Math.max(90, Math.min(720, liveDuration * (0.34 - leadRatio * 0.12)));
        const targetBlend = elapsed > 0 ? 1 - Math.exp(-elapsed / targetMs) : 0;
        const anticipatoryTarget = Math.min(rawTarget, liveContainer.scrollTop + liveLeadPx * (0.45 + leadRatio * 0.35));
        bufferedTarget += (Math.max(rawTarget, bufferedTarget, anticipatoryTarget, liveContainer.scrollTop) - bufferedTarget) * targetBlend;
        const dt = elapsed / 1000;
        const distance = bufferedTarget - liveContainer.scrollTop;
        const responseMs = Math.max(180, Math.min(980, liveDuration * (0.46 - leadRatio * 0.16)));
        const omega = (1000 / responseMs) * 2.25;
        const acceleration = distance * omega * omega - followVelocity * 2 * omega;
        const maxAcceleration = Math.max(12000, Math.min(42000, liveContainer.clientHeight * (58 + leadRatio * 34)));
        const boundedAcceleration = Math.max(-maxAcceleration, Math.min(maxAcceleration, acceleration));
        followVelocity += boundedAcceleration * dt;
        const maxVelocity = Math.max(360, Math.min(4200, liveContainer.clientHeight * (3.4 + leadRatio * 1.4) + Math.abs(distance) * (2.8 + leadRatio * 1.0)));
        followVelocity = Math.max(0, Math.min(maxVelocity, followVelocity));
        const nextTop = liveContainer.scrollTop + followVelocity * dt;
        liveContainer.scrollTop = Math.max(liveContainer.scrollTop, Math.min(rawTarget, nextTop));
        const remaining = rawTarget - liveContainer.scrollTop;
        const snapThreshold = Math.max(2, Math.min(5, followVelocity * dt));
        const canSettle = targetStableMs > Math.max(220, Math.min(760, liveDuration * 0.46));
        if (canSettle && remaining > 0 && remaining <= snapThreshold) {
          liveContainer.scrollTop = rawTarget;
          bufferedTarget = rawTarget;
          followVelocity = 0;
        }
        liveContainer.dataset.lastScrollTop = String(liveContainer.scrollTop);
        if (autoFollowRef.current && tailFollowActiveRef.current) {
          animationFrameRef.current = window.requestAnimationFrame(step);
        } else {
          tailFollowActiveRef.current = false;
          animationFrameRef.current = 0;
        }
        return;
      }

      const target = Math.max(0, liveContainer.scrollHeight - liveContainer.clientHeight);
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = easeInOutCubic(progress);
      liveContainer.scrollTop = start + (target - start) * eased;
      if (progress < 1 && autoFollowRef.current) {
        animationFrameRef.current = window.requestAnimationFrame(step);
      } else {
        tailFollowActiveRef.current = false;
        animationFrameRef.current = 0;
        liveContainer.dataset.lastScrollTop = String(liveContainer.scrollTop);
      }
    };

    animationFrameRef.current = window.requestAnimationFrame(step);
  }

  function resumeAutoFollow(container = messagesRef.current) {
    autoFollowRef.current = true;
    if (!container || !shouldFollowGrowingTail) {
      return;
    }
    container.classList.add("streaming-follow");
    scrollMessagesToBottom({ smooth: true, duration: streamScrollDurationMsRef.current, continuous: shouldFollowGrowingTail });
  }

  function updateAutoFollowFromScroll(container = messagesRef.current) {
    if (!container) {
      return;
    }
    const currentTop = container.scrollTop;
    const previousTop = Number(container.dataset.lastScrollTop);
    const movedUp = Number.isFinite(previousTop) && currentTop < previousTop - 2;
    const userScrolling = Date.now() <= userScrollIntentUntilRef.current;
    const remaining = container.scrollHeight - container.clientHeight - container.scrollTop;
    const threshold = shouldFollowGrowingTail ? Math.max(nearBottomPx, streamingRejoinBottomPx + streamFollowLeadPxRef.current) : nearBottomPx;
    if (movedUp) {
      stopAutoFollow(container);
    } else if (remaining <= threshold) {
      resumeAutoFollow(container);
    } else if (userScrolling) {
      stopAutoFollow(container);
    } else if (Date.now() < autoScrollUntilRef.current) {
      autoFollowRef.current = true;
    } else {
      autoFollowRef.current = false;
    }
    container.dataset.lastScrollTop = String(currentTop);
  }

  useEffect(() => {
    const container = messagesRef.current;
    if (!container || state.historyReadOnly) {
      wasLastAssistantStreamingRef.current = isLastAssistantStreaming;
      wasActiveWorkflowGrowingRef.current = isActiveWorkflowGrowing;
      return;
    }
    if (state.restoringHistory) {
      wasRestoringHistoryRef.current = true;
      return;
    }
    const restoredIntoGrowingTail = wasRestoringHistoryRef.current && shouldFollowGrowingTail;
    wasRestoringHistoryRef.current = false;
    const assistantStreamingStarted = isLastAssistantStreaming && !wasLastAssistantStreamingRef.current;
    const workflowGrowingStarted = isActiveWorkflowGrowing && !wasActiveWorkflowGrowingRef.current;
    wasLastAssistantStreamingRef.current = isLastAssistantStreaming;
    wasActiveWorkflowGrowingRef.current = isActiveWorkflowGrowing;
    if ((assistantStreamingStarted || workflowGrowingStarted || restoredIntoGrowingTail) && Date.now() > userScrollIntentUntilRef.current) {
      autoFollowRef.current = true;
    }
    if (!autoFollowRef.current) {
      return;
    }
    container.style.setProperty("--stream-follow-lead", `${streamFollowLeadPx}px`);
    container.classList.toggle("streaming-follow", Boolean(shouldFollowGrowingTail));
    scrollMessagesToBottom({
      smooth: true,
      duration: streamScrollDurationMsRef.current,
      continuous: shouldFollowGrowingTail,
    });
  }, [state.messages.length, lastMessage?.text, lastMessage?.isComplete, activeWorkflowFollowSignature, state.appSettings.streamScrollDurationMs, streamFollowLeadPx, isLastAssistantStreaming, shouldFollowGrowingTail, state.restoringHistory, state.historyReadOnly]);

  useLayoutEffect(() => {
    const container = messagesRef.current;
    if (!container || !state.restoringHistory || state.pendingHistoryId || !state.activeHistoryId) {
      return;
    }
    stopAutoFollow(container);
    const savedPosition = restoredScrollPosition(state.activeHistoryId);
    container.scrollTop = savedPosition ?? 0;
    container.dataset.lastScrollTop = String(container.scrollTop);
    requestAnimationFrame(() => {
      dispatch({ type: "finish_history_restore" });
    });
  }, [dispatch, state.activeHistoryId, state.messages.length, state.pendingHistoryId, state.restoringHistory]);

  useEffect(() => {
    function handleSaveMessageScroll() {
      saveCurrentScrollPosition();
    }
    window.addEventListener("myharness:saveMessageScroll", handleSaveMessageScroll);
    return () => window.removeEventListener("myharness:saveMessageScroll", handleSaveMessageScroll);
  });

  useEffect(() => {
    function handleMessageBottomFollow() {
      if (state.restoringHistory || state.historyReadOnly) {
        return;
      }
      autoFollowRef.current = true;
      userScrollIntentUntilRef.current = 0;
      scrollMessagesToBottom({ smooth: false, duration: 0 });
      window.requestAnimationFrame(() => {
        scrollMessagesToBottom({ smooth: false, duration: 0 });
      });
    }
    window.addEventListener(messageBottomFollowEvent, handleMessageBottomFollow);
    return () => window.removeEventListener(messageBottomFollowEvent, handleMessageBottomFollow);
  });

  useEffect(() => () => {
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current);
    }
    window.clearTimeout(scrollSaveTimerRef.current);
  }, []);

  return {
    messagesRef,
    autoFollowRef,
    isLastAssistantStreaming,
    shouldFollowGrowingTail,
    handleScroll(container: HTMLElement) {
      updateAutoFollowFromScroll(container);
      scheduleScrollPositionSave();
    },
    handleWheel(container: HTMLElement, deltaY: number) {
      userScrollIntentUntilRef.current = Date.now() + 900;
      if (deltaY < 0) {
        stopAutoFollow(container);
      }
    },
    handlePointerIntent() {
      userScrollIntentUntilRef.current = Date.now() + 900;
    },
    handleVisibleTextChange() {
      if (!autoFollowRef.current || state.restoringHistory || state.historyReadOnly) {
        return;
      }
      scrollMessagesToBottom({
        smooth: true,
        duration: streamScrollDurationMsRef.current,
        continuous: true,
      });
    },
    handleVisibleWorkflowProgressChange() {
      if (!autoFollowRef.current || state.restoringHistory || state.historyReadOnly || !shouldFollowGrowingTail) {
        return;
      }
      scrollMessagesToBottom({
        smooth: true,
        duration: streamScrollDurationMsRef.current,
        continuous: true,
      });
    },
  };
}
