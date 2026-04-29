import assert from "node:assert/strict";
import test from "node:test";

function installBrowserGlobals() {
  globalThis.localStorage = {
    getItem: () => "",
    setItem: () => undefined,
  };
  globalThis.sessionStorage = {
    getItem: () => "",
    setItem: () => undefined,
  };
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: () => [],
  };
}

function createPlanModeContext() {
  const calls = {
    clearedComposerToken: 0,
    clearedPastedTexts: 0,
    clearedAttachments: 0,
    posts: [],
  };
  const state = {
    sessionId: "session-1",
    clientId: "client-1",
    ready: true,
    busy: false,
    attachments: [{ media_type: "image/png", data: "abc", name: "draft.png" }],
    pastedTexts: [{ text: "long pasted draft" }],
    composerToken: { raw: "$skill", kind: "skill", label: "$skill" },
    chatSlots: new Map(),
    activeFrontendId: "",
    activeHistoryId: "",
    chatTitle: "MyHarness",
    autoFollowMessages: false,
    permissionMode: "default",
  };
  const els = {
    input: { value: "draft message" },
    sessionId: { textContent: "" },
  };
  const ctx = {
    state,
    els,
    STATUS_LABELS: { sending: "sending", ready: "ready", startingBackend: "starting" },
    handleEvent: () => undefined,
    setStatus: () => undefined,
    resetWorkflowPanel: () => undefined,
    ensureWorkflowPanel: () => undefined,
    setChatTitle: () => undefined,
    appendMessage: () => undefined,
    setMarkdown: () => undefined,
    scrollMessagesToBottom: () => undefined,
    autoSizeInput: () => undefined,
    setBusy: (value) => {
      state.busy = value;
    },
    saveScrollPosition: () => undefined,
    renderWelcome: () => undefined,
    markActiveHistory: () => undefined,
    updateSendState: () => undefined,
    forgetScrollPosition: () => undefined,
    clearAttachments: () => {
      calls.clearedAttachments += 1;
      state.attachments = [];
    },
    clearPastedTexts: () => {
      calls.clearedPastedTexts += 1;
      state.pastedTexts = [];
    },
    clearComposerToken: () => {
      calls.clearedComposerToken += 1;
      state.composerToken = null;
    },
    updateWorkspaceDisplay: () => undefined,
    resetArtifacts: () => undefined,
    setPlanModeIndicatorActive: (active) => {
      state.permissionMode = active ? "Plan Mode" : "Default";
    },
  };
  return { ctx, calls };
}

test("preserves the composer draft when toggling plan mode outside the input", async () => {
  installBrowserGlobals();
  const { createApi } = await import("../modules/api.js");
  const { ctx, calls } = createPlanModeContext();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.posts.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({}),
    };
  };

  try {
    const api = createApi(ctx);

    await api.sendLine("/plan", { preserveDraft: true });

    assert.equal(ctx.els.input.value, "draft message");
    assert.deepEqual(ctx.state.attachments, [{ media_type: "image/png", data: "abc", name: "draft.png" }]);
    assert.deepEqual(ctx.state.pastedTexts, [{ text: "long pasted draft" }]);
    assert.deepEqual(ctx.state.composerToken, { raw: "$skill", kind: "skill", label: "$skill" });
    assert.equal(calls.clearedAttachments, 0);
    assert.equal(calls.clearedPastedTexts, 0);
    assert.equal(calls.clearedComposerToken, 0);
    assert.equal(calls.posts.length, 1);
    assert.equal(calls.posts[0].url, "/api/message");
    assert.equal(calls.posts[0].body.line, "/plan");
    assert.equal(calls.posts[0].body.sessionId, "session-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
