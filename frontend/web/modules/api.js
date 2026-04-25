export function createApi(ctx) {
  const { state, els, STATUS_LABELS } = ctx;
  function handleEvent(...args) { return ctx.handleEvent(...args); }
  function setStatus(...args) { return ctx.setStatus(...args); }
  function resetWorkflowPanel(...args) { return ctx.resetWorkflowPanel(...args); }
  function ensureWorkflowPanel(...args) { return ctx.ensureWorkflowPanel(...args); }
  function setChatTitle(...args) { return ctx.setChatTitle(...args); }
  function appendMessage(...args) { return ctx.appendMessage(...args); }
  function autoSizeInput(...args) { return ctx.autoSizeInput(...args); }
  function setBusy(...args) { return ctx.setBusy(...args); }
  function saveScrollPosition(...args) { return ctx.saveScrollPosition(...args); }
  function renderWelcome(...args) { return ctx.renderWelcome(...args); }
  function markActiveHistory(...args) { return ctx.markActiveHistory(...args); }
  function updateSendState(...args) { return ctx.updateSendState(...args); }
  function forgetScrollPosition(...args) { return ctx.forgetScrollPosition(...args); }
  function clearAttachments(...args) { return ctx.clearAttachments(...args); }
  function clearComposerToken(...args) { return ctx.clearComposerToken(...args); }

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `HTTP ${response.status}`);
  }
  return response.json();
}

async function startSession() {
  setStatus(STATUS_LABELS.connecting);
  const { sessionId } = await postJson("/api/session", { permissionMode: "full_auto" });
  state.sessionId = sessionId;
  if (els.sessionId) {
    els.sessionId.textContent = sessionId;
  }

  state.source = new EventSource(`/api/events?session=${encodeURIComponent(sessionId)}`);
  state.source.onmessage = (event) => handleEvent(JSON.parse(event.data));
  state.source.onerror = () => {
    if (!state.ready) {
      setStatus(STATUS_LABELS.connectionError);
    }
  };
}

async function sendLine(line) {
  const text = line.trim();
  const attachments = state.attachments.map((attachment) => ({
    media_type: attachment.media_type || attachment.mediaType,
    data: attachment.data,
    name: attachment.name,
  })).filter((attachment) => attachment.media_type && attachment.data);
  if ((!text && attachments.length === 0) || !state.sessionId) {
    return;
  }
  resetWorkflowPanel();
  if (state.chatTitle === "OpenHarness" && !text.startsWith("/")) {
    setChatTitle(text || "이미지 첨부");
  }
  appendMessage("user", text, attachments);
  if (!text.startsWith("/")) {
    ensureWorkflowPanel();
  }
  els.input.value = "";
  clearComposerToken();
  clearAttachments();
  autoSizeInput();
  setBusy(true, STATUS_LABELS.sending);
  state.autoFollowMessages = true;
  await postJson("/api/message", { sessionId: state.sessionId, line: text, attachments });
}

async function sendBackendRequest(payload) {
  if (!state.sessionId) {
    return;
  }
  await postJson("/api/respond", { sessionId: state.sessionId, payload });
}

async function requestSelectCommand(command) {
  if (!command || !state.sessionId || state.busy) {
    return;
  }
  await sendBackendRequest({ type: "select_command", command });
}

async function refreshSkills() {
  if (!state.sessionId) {
    return;
  }
  await sendBackendRequest({ type: "refresh_skills" });
}

async function clearChat() {
  saveScrollPosition();
  els.input.value = "";
  clearComposerToken();
  clearAttachments();
  autoSizeInput();
  state.assistantNode = null;
  state.activeHistoryId = null;
  state.pendingScrollRestoreId = null;
  state.restoringHistory = false;
  state.ignoreScrollSave = false;
  renderWelcome();
  markActiveHistory();
  updateSendState();
  if (state.sessionId) {
    await postJson("/api/message", { sessionId: state.sessionId, line: "/clear" });
    refreshSkills().catch(() => {});
  }
}

async function requestHistory() {
  if (els.historyList.querySelector(".empty")) {
    els.historyList.querySelector(".empty").textContent = "대화 내역을 불러오는 중...";
  }
  await sendBackendRequest({ type: "list_sessions" });
}

async function deleteHistorySession(sessionId, item) {
  if (!sessionId || !state.sessionId) {
    return;
  }
  item?.classList.add("deleting");
  forgetScrollPosition(sessionId);
  if (state.activeHistoryId === sessionId) {
    state.activeHistoryId = null;
    state.pendingScrollRestoreId = null;
    state.restoringHistory = false;
    renderWelcome();
  }
  await sendBackendRequest({ type: "delete_session", value: sessionId });
}

  return {
    postJson,
    startSession,
    sendLine,
    sendBackendRequest,
    requestSelectCommand,
    refreshSkills,
    clearChat,
    requestHistory,
    deleteHistorySession,
  };
}
