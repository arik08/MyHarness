const scrollStorageKey = "openharness:scrollPositions";
let scrollRestoreTimer = 0;
let scrollSaveTimer = 0;

export function createUI(ctx) {
  const { state, els, STATUS_LABELS } = ctx;
  function markActiveHistory(...args) { return ctx.markActiveHistory(...args); }

function readScrollPositions() {
  try {
    return JSON.parse(localStorage.getItem(scrollStorageKey) || "{}");
  } catch {
    return {};
  }
}

function saveScrollPosition(sessionId = state.activeHistoryId) {
  if (!sessionId || state.ignoreScrollSave || state.restoringHistory) {
    return;
  }
  const positions = readScrollPositions();
  positions[sessionId] = els.messages.scrollTop;
  localStorage.setItem(scrollStorageKey, JSON.stringify(positions));
}

function scheduleScrollPositionSave() {
  window.clearTimeout(scrollSaveTimer);
  scrollSaveTimer = window.setTimeout(() => saveScrollPosition(), 120);
}

function restoreScrollPosition(sessionId = state.pendingScrollRestoreId || state.activeHistoryId) {
  if (!sessionId) {
    return false;
  }
  const position = readScrollPositions()[sessionId];
  if (typeof position !== "number") {
    return false;
  }
  els.messages.scrollTop = position;
  return true;
}

function forgetScrollPosition(sessionId) {
  if (!sessionId) {
    return;
  }
  const positions = readScrollPositions();
  delete positions[sessionId];
  localStorage.setItem(scrollStorageKey, JSON.stringify(positions));
}

function isNearMessageBottom() {
  const remaining = els.messages.scrollHeight - els.messages.clientHeight - els.messages.scrollTop;
  return remaining <= 36;
}

function scrollMessagesToBottom() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

function finishScrollRestore() {
  window.clearTimeout(scrollRestoreTimer);
  const hasSavedPosition = restoreScrollPosition();
  if (!hasSavedPosition) {
    scrollMessagesToBottom();
  }
  state.pendingScrollRestoreId = null;
  state.restoringHistory = false;
  requestAnimationFrame(() => {
    state.ignoreScrollSave = false;
  });
}

function scheduleScrollRestore() {
  if (!state.pendingScrollRestoreId) {
    return;
  }
  window.clearTimeout(scrollRestoreTimer);
  scrollRestoreTimer = window.setTimeout(finishScrollRestore, 120);
}

function setChatTitle(value) {
  const title = String(value || "").trim() || "OpenHarness";
  state.chatTitle = title;
  if (els.chatTitle) {
    els.chatTitle.textContent = title.length > 58 ? `${title.slice(0, 55)}...` : title;
  }
  if (state.activeHistoryId) {
    const activeTitle = els.historyList.querySelector(
      `.history-item[data-session-id="${CSS.escape(state.activeHistoryId)}"] .history-open span`,
    );
    if (activeTitle) {
      activeTitle.textContent = title.length > 28 ? `${title.slice(0, 25)}...` : title;
    }
  }
}

function finishTitleEdit(input, commit) {
  const nextTitle = input.value.trim();
  input.remove();
  els.chatTitleButton.classList.remove("editing");
  state.editingTitle = false;
  const label = document.createElement("span");
  els.chatTitleButton.textContent = "";
  els.chatTitleButton.append(label);
  els.chatTitle = label;
  setChatTitle(commit && nextTitle ? nextTitle : state.chatTitle);
}

function startTitleEdit() {
  if (state.editingTitle || !els.chatTitleButton) {
    return;
  }
  state.editingTitle = true;
  const currentTitle = state.chatTitle;
  const input = document.createElement("input");
  input.className = "chat-title-input";
  input.type = "text";
  input.value = currentTitle;
  input.setAttribute("aria-label", "채팅 제목 수정");
  els.chatTitleButton.classList.add("editing");
  els.chatTitleButton.textContent = "";
  els.chatTitleButton.append(input);
  input.focus();
  input.select();
  input.addEventListener("click", (event) => event.stopPropagation());
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finishTitleEdit(input, true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      finishTitleEdit(input, false);
    }
  });
  input.addEventListener("blur", () => finishTitleEdit(input, true), { once: true });
}

function setSidebarCollapsed(collapsed) {
  els.appShell?.classList.toggle("sidebar-collapsed", collapsed);
  const toggle = document.querySelector("[data-action='toggle-sidebar']");
  if (toggle) {
    toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    const label = collapsed ? "사이드바 열기" : "사이드바 닫기";
    toggle.setAttribute("aria-label", label);
    toggle.dataset.tooltip = label;
  }
  localStorage.setItem("openharness:sidebarCollapsed", collapsed ? "1" : "0");
}

function setStatus(label, mode = "") {
  els.readyPill.textContent = label;
  els.readyPill.className = `status-pill ${mode}`.trim();
  if (els.sessionStatus) {
    els.sessionStatus.textContent = label;
  }
}

function renderWelcome() {
  els.messages.textContent = "";
  setChatTitle("OpenHarness");
  const welcome = document.createElement("div");
  welcome.className = "welcome";

  const mark = document.createElement("span");
  mark.className = "welcome-mark";
  mark.textContent = "OH";

  const title = document.createElement("h2");
  title.textContent = "이 작업공간에서 무엇을 도와드릴까요?";

  const copy = document.createElement("p");
  copy.textContent =
    "로컬 OpenHarness 백엔드와 연결되어 있습니다. 질문을 입력하거나, 슬래시 명령어를 실행하거나, 에이전트에게 저장소를 살펴보게 할 수 있습니다.";

  welcome.append(mark, title, copy);
  els.messages.append(welcome);
}

function removeWelcome() {
  const welcome = els.messages.querySelector(".welcome");
  if (welcome) {
    welcome.remove();
  }
}

function updateSendState() {
  const hasText = buildComposerLine().trim().length > 0;
  els.send.disabled = !state.ready || state.busy || (!hasText && state.attachments.length === 0);
}

function setBusy(value, label = value ? STATUS_LABELS.thinking : STATUS_LABELS.ready) {
  state.busy = value;
  setStatus(label, value ? "busy" : state.ready ? "ready" : "");
  updateSendState();
}

function autoSizeInput() {
  els.input.style.height = "auto";
  const nextHeight = Math.min(190, els.input.scrollHeight);
  els.input.style.height = `${nextHeight}px`;
  els.input.style.overflowY = els.input.scrollHeight > 190 ? "auto" : "hidden";
}

function prettifyComposerToken(rawToken) {
  const token = String(rawToken || "").trim();
  if (token.startsWith("/")) {
    return token.slice(1);
  }
  if (!token.startsWith("$")) {
    return token;
  }
  const normalized = token
    .slice(1)
    .replace(/^["']|["']$/g, "")
    .trim();
  const name = (normalized.includes(":") ? normalized.split(":")[0] : normalized)
    .replace(/[-_]+/g, " ")
    .trim();
  return name ? name.replace(/\b\w/g, (char) => char.toUpperCase()) : token;
}

function normalizeSkillTokenName(rawToken) {
  return String(rawToken || "")
    .trim()
    .slice(1)
    .replace(/^["']|["']$/g, "")
    .toLowerCase();
}

function knownCommand(rawToken) {
  const token = String(rawToken || "").trim().toLowerCase();
  if (state.commands.some((command) => String(command.name || "").toLowerCase() === token)) {
    return true;
  }
  return typeof ctx.commandDescription === "function"
    && ctx.commandDescription(token, "__unknown__") !== "__unknown__";
}

function knownSkill(rawToken) {
  const name = normalizeSkillTokenName(rawToken);
  return state.skills.some((skill) => String(skill.name || "").toLowerCase() === name)
    || /^\$[^:\s]+:[^:\s]+$/i.test(String(rawToken || "").trim());
}

function parseComposerToken(value) {
  const text = String(value || "");
  const match = text.match(/^(\$"[^"]+"|\$'[^']+'|\$[^\s]+|\/[a-z][a-z0-9-]*)([\s\S]*)$/i);
  if (!match) {
    return null;
  }
  const raw = match[1];
  const remainder = match[2] || "";
  const hasBoundary = remainder.length > 0 && /^\s/.test(remainder);
  const exactKnown = raw.startsWith("/") ? knownCommand(raw) : knownSkill(raw);
  if (!hasBoundary && !exactKnown) {
    return null;
  }
  return {
    raw,
    rest: remainder.replace(/^\s+/, ""),
    kind: raw.startsWith("$") ? "skill" : "command",
    label: prettifyComposerToken(raw),
  };
}

function renderComposerToken() {
  if (!els.composerToken) {
    return;
  }
  els.composerToken.textContent = "";
  if (!state.composerToken) {
    els.composerToken.className = "composer-token-slot hidden";
    els.composerToken.setAttribute("aria-hidden", "true");
    return;
  }
  els.composerToken.className = `composer-token-slot ${state.composerToken.kind}`;
  els.composerToken.setAttribute("aria-hidden", "false");
  els.composerToken.title = state.composerToken.raw;

  const chip = document.createElement("span");
  chip.className = `prompt-token ${state.composerToken.kind}`;
  chip.textContent = state.composerToken.label;
  els.composerToken.append(chip);
}

function setComposerToken(token) {
  state.composerToken = token;
  renderComposerToken();
  updateSendState();
}

function clearComposerToken() {
  state.composerToken = null;
  renderComposerToken();
  updateSendState();
}

function setComposerTokenFromSelection(item) {
  if (!item) {
    return false;
  }
  if (item.kind === "skill") {
    const raw = `$${item.name.slice(1)}`;
    els.input.value = "";
    setComposerToken({ raw, kind: "skill", label: prettifyComposerToken(raw) });
  } else {
    els.input.value = "";
    setComposerToken({ raw: item.name, kind: "command", label: prettifyComposerToken(item.name) });
  }
  autoSizeInput();
  els.input.focus();
  return true;
}

function updateComposerTokenFromInput() {
  if (state.composerToken) {
    return false;
  }
  if ((els.input.selectionStart || 0) !== els.input.value.length) {
    return false;
  }
  const parsed = parseComposerToken(els.input.value);
  if (!parsed) {
    return false;
  }
  els.input.value = parsed.rest;
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  setComposerToken({ raw: parsed.raw, kind: parsed.kind, label: parsed.label });
  if (ctx.closeSlashMenu) {
    ctx.closeSlashMenu();
  }
  autoSizeInput();
  return true;
}

function buildComposerLine(value = els.input.value) {
  const rest = String(value || "").trim();
  if (!state.composerToken) {
    return rest;
  }
  return [state.composerToken.raw, rest].filter(Boolean).join(" ");
}

function renderAttachments() {
  if (!els.attachmentTray) {
    return;
  }
  els.attachmentTray.textContent = "";
  els.attachmentTray.classList.toggle("hidden", state.attachments.length === 0);
  for (const attachment of state.attachments) {
    const item = document.createElement("div");
    item.className = "attachment-chip";

    const image = document.createElement("img");
    image.src = `data:${attachment.mediaType};base64,${attachment.data}`;
    image.alt = attachment.name || "첨부 이미지";

    const label = document.createElement("span");
    label.textContent = attachment.name || "이미지";
    label.title = attachment.name || "이미지";

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", "첨부 이미지 삭제");
    remove.dataset.id = attachment.id;
    remove.textContent = "x";

    item.append(image, label, remove);
    els.attachmentTray.append(item);
  }
}

function clearAttachments() {
  state.attachments = [];
  renderAttachments();
  updateSendState();
}

els.composerToken?.addEventListener("click", () => {
  clearComposerToken();
  els.input.focus();
});

  return {
    saveScrollPosition,
    scheduleScrollPositionSave,
    restoreScrollPosition,
    forgetScrollPosition,
    isNearMessageBottom,
    scrollMessagesToBottom,
    finishScrollRestore,
    scheduleScrollRestore,
    setChatTitle,
    startTitleEdit,
    setSidebarCollapsed,
    setStatus,
    renderWelcome,
    removeWelcome,
    updateSendState,
    setBusy,
    autoSizeInput,
    clearComposerToken,
    setComposerTokenFromSelection,
    updateComposerTokenFromInput,
    buildComposerLine,
    renderAttachments,
    clearAttachments,
  };
}
