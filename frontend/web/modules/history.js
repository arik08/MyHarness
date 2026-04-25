export function createHistory(ctx) {
  const { state, els, STATUS_LABELS } = ctx;
  function closeModal(...args) { return ctx.closeModal(...args); }
  function saveScrollPosition(...args) { return ctx.saveScrollPosition(...args); }
  function setChatTitle(...args) { return ctx.setChatTitle(...args); }
  function setBusy(...args) { return ctx.setBusy(...args); }
  function sendBackendRequest(...args) { return ctx.sendBackendRequest(...args); }
  function deleteHistorySession(...args) { return ctx.deleteHistorySession(...args); }
  function appendMessage(...args) { return ctx.appendMessage(...args); }
  function switchChatSlot(...args) { return ctx.switchChatSlot?.(...args); }

function liveHistoryOptions() {
  return [...state.chatSlots.values()]
    .filter((slot) => slot.busy || slot.frontendId === state.activeFrontendId)
    .map((slot) => ({
      value: `live:${slot.frontendId}`,
      label: slot.title || "진행 중인 채팅",
      description: slot.busy ? "진행 중" : "열려 있음",
      liveSlotId: slot.frontendId,
      busy: Boolean(slot.busy),
    }));
}

function renderHistory(options) {
  els.historyList.textContent = "";
  const liveOptions = liveHistoryOptions();
  const savedOptions = Array.isArray(options) ? options : [];
  const mergedOptions = [...liveOptions, ...savedOptions];
  if (!mergedOptions.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "저장된 세션이 아직 없습니다.";
    els.historyList.append(empty);
    return;
  }

  for (const option of mergedOptions) {
    const item = document.createElement("div");
    const isLive = Boolean(option.liveSlotId);
    const isActive = isLive
      ? state.activeFrontendId === option.liveSlotId
      : state.activeHistoryId === option.value;
    item.className = `history-item${isActive ? " active" : ""}${option.busy || (isActive && state.busy) ? " busy" : ""}`;
    item.dataset.sessionId = option.value || "";
    if (isLive) {
      item.dataset.liveSlotId = option.liveSlotId;
    }

    const formattedTitle = formatHistoryTitle(option.label || option.value || "저장된 세션");
    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = formattedTitle;
    const detail = document.createElement("small");
    detail.textContent = option.description || option.label || "저장된 대화";
    item.title = detail.textContent;

    const openButton = document.createElement("button");
    openButton.type = "button";
    openButton.className = "history-open";
    openButton.append(title, detail);
    openButton.addEventListener("click", async () => {
      closeModal();
      if (isLive) {
        switchChatSlot(option.liveSlotId);
        return;
      }
      saveScrollPosition();
      els.messages.textContent = "";
      state.activeHistoryId = option.value || null;
      state.pendingScrollRestoreId = state.activeHistoryId;
      state.restoringHistory = true;
      state.batchingHistoryRestore = true;
      state.ignoreScrollSave = true;
      setChatTitle(formattedTitle);
      markActiveHistory();
      setBusy(true, STATUS_LABELS.restoring);
      await sendBackendRequest({ type: "apply_select_command", command: "resume", value: option.value });
    });

    const busySpinner = document.createElement("span");
    busySpinner.className = "history-busy-spinner";
    busySpinner.setAttribute("aria-hidden", "true");

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "history-delete";
    deleteButton.setAttribute("aria-label", "기록 삭제");
    deleteButton.title = "기록 삭제";
    deleteButton.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M10 11v6"></path>
        <path d="M14 11v6"></path>
        <path d="M4 7h16"></path>
        <path d="M6 7l1 14h10l1-14"></path>
        <path d="M9 7V4h6v3"></path>
      </svg>
    `;
    if (isLive) {
      deleteButton.disabled = true;
      deleteButton.classList.add("hidden");
    } else {
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteHistorySession(option.value || "", item).catch((error) => {
          item.classList.remove("deleting");
          appendMessage("system", `기록 삭제 실패: ${error.message}`);
          setBusy(false, STATUS_LABELS.error);
        });
      });
    }

    item.append(openButton, busySpinner, deleteButton);
    els.historyList.append(item);
  }
}

function formatHistoryTitle(label) {
  const withoutPrefix = String(label || "")
    .replace(/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s+\d+\s*msg\s*/i, "")
    .replace(/^\d{1,2}\/\d{1,2}\s+\d{1,2}:\d{2}\s*/i, "")
    .trim();
  return withoutPrefix || "저장된 대화";
}

function markActiveHistory() {
  els.historyList.querySelectorAll(".history-item").forEach((item) => {
    const liveSlot = item.dataset.liveSlotId ? state.chatSlots.get(item.dataset.liveSlotId) : null;
    const isActive = liveSlot
      ? item.dataset.liveSlotId === state.activeFrontendId
      : item.dataset.sessionId === state.activeHistoryId;
    item.classList.toggle("active", isActive);
    item.classList.toggle("busy", Boolean(liveSlot?.busy) || (isActive && state.busy));
  });
}

  return {
    renderHistory,
    formatHistoryTitle,
    markActiveHistory,
  };
}
