export function createHistory(ctx) {
  const { state, els, STATUS_LABELS } = ctx;
  function closeModal(...args) { return ctx.closeModal(...args); }
  function saveScrollPosition(...args) { return ctx.saveScrollPosition(...args); }
  function setChatTitle(...args) { return ctx.setChatTitle(...args); }
  function setBusy(...args) { return ctx.setBusy(...args); }
  function sendBackendRequest(...args) { return ctx.sendBackendRequest(...args); }
  function deleteHistorySession(...args) { return ctx.deleteHistorySession(...args); }
  function appendMessage(...args) { return ctx.appendMessage(...args); }

function renderHistory(options) {
  els.historyList.textContent = "";
  if (!options.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "저장된 세션이 아직 없습니다.";
    els.historyList.append(empty);
    return;
  }

  for (const option of options) {
    const item = document.createElement("div");
    item.className = `history-item${state.activeHistoryId === option.value ? " active" : ""}`;
    item.dataset.sessionId = option.value || "";

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
      saveScrollPosition();
      els.messages.textContent = "";
      state.activeHistoryId = option.value || null;
      state.pendingScrollRestoreId = state.activeHistoryId;
      state.restoringHistory = true;
      state.ignoreScrollSave = true;
      setChatTitle(formattedTitle);
      markActiveHistory();
      setBusy(true, STATUS_LABELS.restoring);
      await sendBackendRequest({ type: "apply_select_command", command: "resume", value: option.value });
    });

    const deleteButton = document.createElement("button");
    deleteButton.type = "button";
    deleteButton.className = "history-delete";
    deleteButton.setAttribute("aria-label", "기록 삭제");
    deleteButton.title = "기록 삭제";
    deleteButton.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d="M3 6h18"></path>
        <path d="M8 6V4h8v2"></path>
        <path d="M19 6l-1 14H6L5 6"></path>
        <path d="M10 11v5"></path>
        <path d="M14 11v5"></path>
      </svg>
    `;
    deleteButton.addEventListener("click", (event) => {
      event.stopPropagation();
      deleteHistorySession(option.value || "", item).catch((error) => {
        item.classList.remove("deleting");
        appendMessage("system", `기록 삭제 실패: ${error.message}`);
        setBusy(false, STATUS_LABELS.error);
      });
    });

    item.append(openButton, deleteButton);
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
    item.classList.toggle("active", item.dataset.sessionId === state.activeHistoryId);
  });
}

  return {
    renderHistory,
    formatHistoryTitle,
    markActiveHistory,
  };
}
