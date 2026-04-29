import assert from "node:assert/strict";
import test from "node:test";

function createContext() {
  const workflowTurns = [];
  const state = {
    activeFrontendId: "slot-1",
    activeHistoryId: "",
    assistantNode: null,
    autoFollowMessages: false,
    batchingHistoryRestore: false,
    busy: false,
    chatSlots: new Map([
      ["slot-1", {
        frontendId: "slot-1",
        busy: false,
        container: { querySelector: () => null },
        showInHistory: false,
      }],
    ]),
    ignoreScrollSave: false,
    pendingScrollRestoreId: "",
    restoreTimeoutId: 0,
    restoringHistory: false,
    suppressNextLineCompleteScroll: false,
    workflowNode: null,
  };
  let lastUserText = "";

  return {
    state,
    workflowTurns,
    els: {
      messages: {
        textContent: "",
        classList: {
          remove: () => undefined,
          toggle: () => undefined,
        },
      },
    },
    STATUS_LABELS: {
      ready: "준비됨",
      restoring: "복원 중",
    },
    appendMessage: (role, text) => {
      if (role === "user") {
        lastUserText = text;
      }
      return {};
    },
    appendWorkflowEvent: (event) => {
      if (!state.workflowNode) {
        state.workflowNode = { userText: lastUserText };
        workflowTurns.push(state.workflowNode);
      }
      state.workflowNode.events = state.workflowNode.events || [];
      state.workflowNode.events.push(event.tool_name);
    },
    archiveTodoChecklist: () => undefined,
    cachedHistoryForWorkspace: () => [],
    clearWorkflowFinalAnswerStep: () => undefined,
    closeInlineQuestion: () => undefined,
    collapseWorkflowPanel: () => undefined,
    commandDescription: (_name, description) => description,
    extractAndRenderArtifacts: () => undefined,
    failWorkflowPanel: () => undefined,
    finishScrollRestore: () => undefined,
    finalizeWorkflowSummary: () => undefined,
    markActiveHistory: () => undefined,
    markWorkflowFinalAnswerDone: () => undefined,
    renderHistory: () => undefined,
    renderTodoChecklist: () => undefined,
    renderWelcome: () => undefined,
    requestHistory: () => Promise.resolve(),
    resetArtifacts: () => undefined,
    resetTodoChecklist: () => undefined,
    resetWorkflowPanel: () => {
      state.workflowNode = null;
    },
    scrollMessagesToBottom: () => undefined,
    setBusy: () => undefined,
    setChatTitle: () => undefined,
    setMarkdown: () => undefined,
    setPlanModeIndicatorActive: () => undefined,
    setStatus: () => undefined,
    showModal: () => undefined,
    showSelect: () => undefined,
    startWorkflowFinalAnswer: () => undefined,
    updateSendState: () => undefined,
    updateSlashMenu: () => undefined,
    updateState: () => undefined,
    updateTasks: () => undefined,
  };
}

test("restored workflow events are grouped under each user turn", async () => {
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  };
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  globalThis.requestAnimationFrame = (callback) => {
    callback();
    return 1;
  };
  globalThis.window = {
    clearInterval: () => undefined,
    clearTimeout: () => undefined,
    requestAnimationFrame: globalThis.requestAnimationFrame,
  };

  const ctx = createContext();
  const { createEvents } = await import("../modules/events.js");
  const events = createEvents(ctx);

  events.handleEvent({
    type: "history_snapshot",
    value: "saved-1",
    message: "저장된 대화",
    history_events: [
      { type: "user", text: "첫 질문" },
      { type: "tool_started", tool_name: "Read", tool_input: {} },
      { type: "tool_completed", tool_name: "Read", output: "ok" },
      { type: "assistant", text: "첫 답변" },
      { type: "user", text: "추가 질문" },
      { type: "tool_started", tool_name: "Bash", tool_input: {} },
      { type: "tool_completed", tool_name: "Bash", output: "ok" },
      { type: "assistant", text: "추가 답변" },
    ],
  });

  assert.deepEqual(
    ctx.workflowTurns.map((turn) => ({ userText: turn.userText, events: turn.events })),
    [
      { userText: "첫 질문", events: ["Read", "Read"] },
      { userText: "추가 질문", events: ["Bash", "Bash"] },
    ],
  );
});
