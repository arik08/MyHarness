import { marked } from "/vendor/marked/marked.esm.js";
import katex from "/vendor/katex/katex.mjs";

const state = {
  sessionId: null,
  ready: false,
  busy: false,
  assistantNode: null,
  source: null,
  chatTitle: "OpenHarness",
  activeHistoryId: null,
  commands: [],
  slashMenuOpen: false,
  slashMenuIndex: 0,
  restoringHistory: false,
  pendingScrollRestoreId: null,
  ignoreScrollSave: false,
  autoFollowMessages: true,
};

const els = {
  messages: document.querySelector("#messages"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#promptInput"),
  send: document.querySelector("#sendButton"),
  sessionStatus: document.querySelector("#sessionStatus"),
  sessionId: document.querySelector("#sessionId"),
  readyPill: document.querySelector("#readyPill"),
  model: document.querySelector("#modelValue"),
  provider: document.querySelector("#providerValue"),
  permission: document.querySelector("#permissionValue"),
  cwd: document.querySelector("#cwdValue"),
  toolList: document.querySelector("#toolList"),
  taskList: document.querySelector("#taskList"),
  modalHost: document.querySelector("#modalHost"),
  historyList: document.querySelector("#historyList"),
  chatTitle: document.querySelector("#chatTitle span"),
  slashMenu: document.querySelector("#slashMenu"),
};

const STATUS_LABELS = {
  connecting: "연결 중",
  startingBackend: "백엔드 시작 중",
  ready: "준비됨",
  thinking: "생각 중",
  sending: "전송 중",
  processing: "처리 중",
  restoring: "복원 중",
  error: "오류",
  stopped: "백엔드 중지됨",
  startFailed: "시작 실패",
  connectionError: "연결 오류",
};

const COMMAND_DESCRIPTIONS = {
  "/agents": "에이전트와 팀 작업을 조회합니다",
  "/autopilot": "저장소 자동 작업 입력과 컨텍스트를 관리합니다",
  "/branch": "Git 브랜치 정보를 보여줍니다",
  "/bridge": "브리지 헬퍼와 브리지 세션을 확인합니다",
  "/clear": "현재 대화 기록을 지웁니다",
  "/commit": "Git 상태를 보거나 커밋을 생성합니다",
  "/compact": "오래된 대화 기록을 압축합니다",
  "/config": "설정을 보거나 변경합니다",
  "/context": "현재 런타임 시스템 프롬프트를 보여줍니다",
  "/continue": "중단된 도구 루프를 이어서 실행합니다",
  "/copy": "최근 응답이나 입력한 텍스트를 복사합니다",
  "/cost": "토큰 사용량과 예상 비용을 보여줍니다",
  "/diff": "Git diff 출력을 보여줍니다",
  "/doctor": "환경 진단 정보를 보여줍니다",
  "/effort": "추론 강도를 보거나 변경합니다",
  "/exit": "OpenHarness를 종료합니다",
  "/export": "현재 대화 기록을 내보냅니다",
  "/fast": "빠른 모드를 보거나 변경합니다",
  "/feedback": "CLI 피드백을 로컬 로그에 저장합니다",
  "/files": "현재 작업공간의 파일을 나열합니다",
  "/help": "사용 가능한 명령어를 보여줍니다",
  "/hooks": "설정된 훅을 보여줍니다",
  "/init": "프로젝트 OpenHarness 파일을 초기화합니다",
  "/issue": "프로젝트 이슈 컨텍스트를 보거나 변경합니다",
  "/keybindings": "적용된 키 바인딩을 보여줍니다",
  "/login": "인증 상태를 보거나 API 키를 저장합니다",
  "/logout": "저장된 API 키를 지웁니다",
  "/mcp": "MCP 상태를 보여줍니다",
  "/memory": "프로젝트 메모리를 확인하고 관리합니다",
  "/model": "기본 모델을 보거나 변경합니다",
  "/onboarding": "빠른 시작 안내를 보여줍니다",
  "/output-style": "출력 스타일을 보거나 변경합니다",
  "/passes": "추론 반복 횟수를 보거나 변경합니다",
  "/permissions": "권한 모드를 보거나 변경합니다",
  "/plan": "계획 모드를 켜거나 끕니다",
  "/plugin": "플러그인을 관리합니다",
  "/pr_comments": "PR 코멘트 컨텍스트를 보거나 변경합니다",
  "/privacy-settings": "로컬 개인정보와 저장 설정을 보여줍니다",
  "/provider": "프로바이더 프로필을 보거나 전환합니다",
  "/rate-limit-options": "요청 제한을 줄이는 방법을 보여줍니다",
  "/release-notes": "최근 릴리스 노트를 보여줍니다",
  "/reload-plugins": "이 작업공간의 플러그인 검색을 다시 실행합니다",
  "/resume": "최근 저장된 세션을 복원합니다",
  "/rewind": "최근 대화 턴을 되돌립니다",
  "/session": "현재 세션 저장 정보를 확인합니다",
  "/share": "공유 가능한 대화 스냅샷을 만듭니다",
  "/ship": "ohmo 기반 저장소 작업을 큐에 넣고 실행합니다",
  "/skills": "사용 가능한 스킬을 보거나 자세히 확인합니다",
  "/stats": "세션 통계를 보여줍니다",
  "/status": "세션 상태를 보여줍니다",
  "/subagents": "서브에이전트 사용량과 작업을 확인합니다",
  "/summary": "대화 기록을 요약합니다",
  "/tag": "현재 세션의 이름 있는 스냅샷을 만듭니다",
  "/tasks": "백그라운드 작업을 관리합니다",
  "/theme": "TUI 테마를 보거나 변경합니다",
  "/turns": "최대 에이전트 턴 수를 보거나 변경합니다",
  "/upgrade": "업그레이드 안내를 보여줍니다",
  "/usage": "사용량과 토큰 추정치를 보여줍니다",
  "/version": "설치된 OpenHarness 버전을 보여줍니다",
  "/vim": "Vim 모드를 보거나 변경합니다",
  "/voice": "음성 모드를 보거나 변경합니다",
};

const scrollStorageKey = "openharness:scrollPositions";
let scrollRestoreTimer = 0;
let scrollSaveTimer = 0;

function commandDescription(command, fallback = "") {
  return COMMAND_DESCRIPTIONS[command] || fallback || "명령어를 실행합니다";
}

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

function splitTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function expandCompactTable(line) {
  const cells = splitTableRow(line);
  const dividerStart = cells.findIndex((cell) => /^:?-{3,}:?$/.test(cell));
  if (dividerStart <= 0) {
    return line;
  }
  const header = cells.slice(0, dividerStart);
  const columnCount = header.length;
  const divider = cells.slice(dividerStart, dividerStart + columnCount);
  if (divider.length !== columnCount || !divider.every((cell) => /^:?-{3,}:?$/.test(cell))) {
    return line;
  }
  const bodyCells = cells.slice(dividerStart + columnCount);
  if (!bodyCells.length || bodyCells.length % columnCount !== 0) {
    return line;
  }
  const rows = [header, divider];
  for (let index = 0; index < bodyCells.length; index += columnCount) {
    rows.push(bodyCells.slice(index, index + columnCount));
  }
  return rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
}

function normalizeMarkdown(markdown) {
  return String(markdown || "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => (line.includes("|") ? expandCompactTable(line) : line))
    .join("\n");
}

marked.use({
  gfm: true,
  breaks: true,
  extensions: [
    {
      name: "displayMath",
      level: "block",
      start(source) {
        return source.match(/\\\[/)?.index;
      },
      tokenizer(source) {
        const match = source.match(/^\\\[([\s\S]+?)\\\](?:\n|$)/);
        if (!match) {
          return undefined;
        }
        return { type: "displayMath", raw: match[0], text: match[1].trim() };
      },
      renderer(token) {
        return katex.renderToString(token.text, { displayMode: true, throwOnError: false });
      },
    },
    {
      name: "inlineMath",
      level: "inline",
      start(source) {
        return source.match(/\\\(/)?.index;
      },
      tokenizer(source) {
        const match = source.match(/^\\\((.+?)\\\)/);
        if (!match) {
          return undefined;
        }
        return { type: "inlineMath", raw: match[0], text: match[1].trim() };
      },
      renderer(token) {
        return katex.renderToString(token.text, { displayMode: false, throwOnError: false });
      },
    },
  ],
});

function renderMarkdown(markdown) {
  return marked.parse(normalizeMarkdown(markdown));
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Fall through to the selection-based copy path.
    }
  }
  const textArea = document.createElement("textarea");
  textArea.value = text;
  textArea.setAttribute("readonly", "");
  textArea.style.position = "fixed";
  textArea.style.top = "-1000px";
  textArea.style.opacity = "0";
  document.body.append(textArea);
  textArea.select();
  const copied = document.execCommand("copy");
  textArea.remove();
  if (!copied) {
    throw new Error("Copy failed");
  }
}

function enhanceCodeBlocks(element) {
  element.querySelectorAll("pre").forEach((pre) => {
    if (pre.querySelector(".code-copy")) {
      return;
    }
    const code = pre.querySelector("code");
    if (!code) {
      return;
    }
    if (!code.dataset.highlighted && window.hljs) {
      window.hljs.highlightElement(code);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.setAttribute("aria-label", "Copy code");
    button.title = "Copy code";
    button.innerHTML = `
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <rect x="9" y="9" width="10" height="10" rx="2"></rect>
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
      </svg>
      <span>Copy</span>
    `;
    button.addEventListener("click", async () => {
      const text = code.textContent || "";
      try {
        await copyTextToClipboard(text);
        button.classList.add("copied");
        button.querySelector("span").textContent = "Copied";
        window.setTimeout(() => {
          button.classList.remove("copied");
          button.querySelector("span").textContent = "Copy";
        }, 1300);
      } catch (error) {
        button.querySelector("span").textContent = "Failed";
        window.setTimeout(() => {
          button.querySelector("span").textContent = "Copy";
        }, 1300);
      }
    });
    pre.append(button);
  });
}
function setMarkdown(element, text) {
  element.dataset.rawText = text;
  element.innerHTML = renderMarkdown(text);
  enhanceCodeBlocks(element);
}

function isCommandCatalog(text) {
  return String(text || "").trim().startsWith("Available commands:");
}

function parseCommandCatalog(text) {
  const source = String(text || "").replace(/^Available commands:\s*/i, "").trim();
  const matches = [...source.matchAll(/\/[a-z][a-z0-9-]*/g)];
  if (!matches.length) {
    return [];
  }
  return matches.map((match, index) => {
    const next = matches[index + 1];
    const start = match.index + match[0].length;
    const end = next ? next.index : source.length;
    return {
      name: match[0],
      description: source.slice(start, end).trim(),
    };
  });
}

function createCommandCatalog(text) {
  const commands = parseCommandCatalog(text);
  const details = document.createElement("details");
  details.className = "command-card";
  details.open = true;

  const summary = document.createElement("summary");
  const label = document.createElement("span");
  label.textContent = "사용 가능한 명령어";
  const count = document.createElement("span");
  count.className = "command-count";
  count.textContent = commands.length ? `${commands.length}개` : "열기";
  summary.append(label, count);
  details.append(summary);

  const grid = document.createElement("div");
  grid.className = "command-grid";
  if (!commands.length) {
    const fallback = document.createElement("div");
    fallback.className = "markdown-body";
    setMarkdown(fallback, text);
    grid.append(fallback);
  } else {
    for (const command of commands) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "command-pill";
      item.addEventListener("click", () => {
        sendLine(command.name).catch((error) => {
          appendMessage("system", `명령어 실행 실패: ${error.message}`);
          setBusy(false, STATUS_LABELS.error);
        });
      });
      const name = document.createElement("strong");
      name.textContent = command.name;
      const description = document.createElement("span");
      description.textContent = commandDescription(command.name, command.description);
      item.append(name, description);
      grid.append(item);
    }
  }
  details.append(grid);
  return details;
}

function appendMessage(role, text) {
  removeWelcome();
  const article = document.createElement("article");
  const commandCatalog = role !== "user" && isCommandCatalog(text);
  article.className = `message ${commandCatalog ? "system command-output" : role}`;

  const bubble = document.createElement("div");
  bubble.className = "bubble";
  let content;
  if (commandCatalog) {
    content = createCommandCatalog(text);
    bubble.append(content);
  } else {
    content = document.createElement("div");
    content.className = "markdown-body";
    setMarkdown(content, text);
    bubble.append(content);
  }
  article.append(bubble);
  els.messages.append(article);
  if (state.restoringHistory) {
    scheduleScrollRestore();
  } else {
    scrollMessagesToBottom();
  }
  return content;
}

function updateSendState() {
  els.send.disabled = !state.ready || state.busy || els.input.value.trim().length === 0;
}

function getSlashQuery() {
  const value = els.input.value;
  const beforeCursor = value.slice(0, els.input.selectionStart || 0);
  if (!beforeCursor.startsWith("/") || beforeCursor.includes(" ")) {
    return null;
  }
  return beforeCursor.slice(1).toLowerCase();
}

function filteredSlashCommands() {
  const query = getSlashQuery();
  if (query === null) {
    return [];
  }
  return state.commands
    .filter((command) => command.name.slice(1).toLowerCase().includes(query))
    .slice(0, 12);
}

function closeSlashMenu() {
  state.slashMenuOpen = false;
  state.slashMenuIndex = 0;
  els.slashMenu.classList.add("hidden");
  els.slashMenu.textContent = "";
}

function selectSlashCommand(command) {
  els.input.value = `${command.name} `;
  els.input.setSelectionRange(els.input.value.length, els.input.value.length);
  autoSizeInput();
  updateSendState();
  closeSlashMenu();
  els.input.focus();
}

function renderSlashMenu() {
  const commands = filteredSlashCommands();
  if (!commands.length) {
    closeSlashMenu();
    return;
  }
  state.slashMenuOpen = true;
  state.slashMenuIndex = Math.min(state.slashMenuIndex, commands.length - 1);
  els.slashMenu.textContent = "";
  for (const [index, command] of commands.entries()) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = `slash-menu-item${index === state.slashMenuIndex ? " active" : ""}`;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", index === state.slashMenuIndex ? "true" : "false");
    const name = document.createElement("strong");
    name.textContent = command.name;
    const description = document.createElement("span");
    description.textContent = commandDescription(command.name, command.description);
    item.append(name, description);
    item.addEventListener("mousedown", (event) => {
      event.preventDefault();
      selectSlashCommand(command);
    });
    els.slashMenu.append(item);
  }
  els.slashMenu.classList.remove("hidden");
  els.slashMenu.querySelector(".slash-menu-item.active")?.scrollIntoView({ block: "nearest" });
}

function updateSlashMenu() {
  const query = getSlashQuery();
  if (query === null || !state.commands.length) {
    closeSlashMenu();
    return;
  }
  renderSlashMenu();
}

function setBusy(value, label = value ? STATUS_LABELS.thinking : STATUS_LABELS.ready) {
  state.busy = value;
  setStatus(label, value ? "busy" : state.ready ? "ready" : "");
  updateSendState();
}

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
  if (!text || !state.sessionId) {
    return;
  }
  if (state.chatTitle === "OpenHarness" && !text.startsWith("/")) {
    setChatTitle(text);
  }
  appendMessage("user", text);
  els.input.value = "";
  autoSizeInput();
  setBusy(true, STATUS_LABELS.sending);
  state.autoFollowMessages = true;
  await postJson("/api/message", { sessionId: state.sessionId, line: text });
}

async function sendBackendRequest(payload) {
  if (!state.sessionId) {
    return;
  }
  await postJson("/api/respond", { sessionId: state.sessionId, payload });
}

async function clearChat() {
  saveScrollPosition();
  els.input.value = "";
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
  }
}

async function requestHistory() {
  if (els.historyList.querySelector(".empty")) {
    els.historyList.querySelector(".empty").textContent = "저장된 세션을 불러오는 중...";
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

function handleEvent(event) {
  if (event.type === "web_session") {
    setStatus(STATUS_LABELS.startingBackend);
    return;
  }

  if (event.type === "ready") {
    state.ready = true;
    state.commands = Array.isArray(event.commands)
      ? event.commands
          .map((command) =>
            typeof command === "string"
              ? { name: command, description: commandDescription(command) }
              : {
                  name: command.name || "",
                  description: commandDescription(command.name || "", command.description || ""),
                },
          )
          .filter((command) => command.name.startsWith("/"))
          .sort((left, right) => left.name.localeCompare(right.name))
      : [];
    setBusy(false, STATUS_LABELS.ready);
    updateState(event.state);
    updateTasks(event.tasks || []);
    updateSendState();
    requestHistory().catch(() => {
      renderHistory([]);
    });
    return;
  }

  if (event.type === "state_snapshot") {
    updateState(event.state);
    return;
  }

  if (event.type === "tasks_snapshot") {
    updateTasks(event.tasks || []);
    return;
  }

  if (event.type === "transcript_item" && event.item) {
    if (event.item.role === "user") {
      return;
    }
    if (event.item.role === "system" && event.item.text === "Conversation cleared.") {
      return;
    }
    if (event.item.role === "system" && String(event.item.text || "").startsWith("Session restored")) {
      return;
    }
    if (event.item.role === "assistant") {
      appendMessage("assistant", event.item.text || "");
      return;
    }
    if (event.item.role === "system" && String(event.item.text || "").startsWith("> ")) {
      const userText = String(event.item.text || "").slice(2);
      if (state.chatTitle === "OpenHarness" && !userText.startsWith("/")) {
        setChatTitle(userText);
      }
      appendMessage("user", userText);
      return;
    }
    appendMessage(event.item.role === "log" ? "log" : "system", event.item.text || "");
    return;
  }

  if (event.type === "clear_transcript") {
    renderWelcome();
    state.assistantNode = null;
    return;
  }

  if (event.type === "assistant_delta") {
    if (!state.assistantNode) {
      state.assistantNode = appendMessage("assistant", "");
    }
    const nextText = (state.assistantNode.dataset.rawText || "") + (event.message || "");
    setMarkdown(state.assistantNode, nextText);
    if (!state.restoringHistory && state.autoFollowMessages) {
      scrollMessagesToBottom();
    }
    return;
  }

  if (event.type === "assistant_complete") {
    if (state.assistantNode) {
      setMarkdown(state.assistantNode, event.message || state.assistantNode.dataset.rawText || "");
      state.assistantNode = null;
    } else if (event.message) {
      appendMessage("assistant", event.message);
    }
    return;
  }

  if (event.type === "line_complete") {
    state.assistantNode = null;
    if (state.restoringHistory) {
      requestAnimationFrame(finishScrollRestore);
    }
    setBusy(false, STATUS_LABELS.ready);
    return;
  }

  if (event.type === "tool_started" || event.type === "tool_completed") {
    setBusy(true, event.type === "tool_started" ? `${event.tool_name} 실행 중` : STATUS_LABELS.processing);
    appendToolEvent(event);
    return;
  }

  if (event.type === "modal_request") {
    showModal(event.modal || {});
    return;
  }

  if (event.type === "select_request") {
    if ((event.modal || {}).command === "resume") {
      renderHistory(event.select_options || []);
      return;
    }
    showSelect(event);
    return;
  }

  if (event.type === "error") {
    appendMessage("system", `오류: ${event.message || "알 수 없는 오류"}`);
    setBusy(false, STATUS_LABELS.error);
    return;
  }

  if (event.type === "shutdown") {
    state.ready = false;
    setStatus(STATUS_LABELS.stopped);
    updateSendState();
  }
}

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

    const title = document.createElement("span");
    title.textContent = formatHistoryTitle(option.label || option.value || "저장된 세션");
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
      setChatTitle(title.textContent);
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

function updateState(snapshot = {}) {
  els.model.textContent = snapshot.model || "-";
  els.provider.textContent = snapshot.provider || "-";
  els.permission.textContent = snapshot.permission_mode || "-";
  els.cwd.textContent = snapshot.cwd || "-";
}

function appendToolEvent(event) {
  if (els.toolList.querySelector(".empty")) {
    els.toolList.textContent = "";
  }
  const card = document.createElement("div");
  card.className = "event-card";

  const title = document.createElement("strong");
  title.textContent = event.tool_name || "도구";
  const phase = document.createElement("small");
  phase.textContent = event.type === "tool_started" ? "실행 시작" : "실행 완료";
  const detail = document.createElement("small");
  const raw =
    event.type === "tool_started"
      ? JSON.stringify(event.tool_input || {}, null, 2)
      : event.output || "완료됨";
  detail.textContent = raw.length > 260 ? `${raw.slice(0, 260)}...` : raw;

  card.append(title, phase, detail);
  els.toolList.prepend(card);
}

function updateTasks(tasks) {
  els.taskList.textContent = "";
  if (!tasks.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "진행 중인 작업이 없습니다.";
    els.taskList.append(empty);
    return;
  }
  for (const task of tasks) {
    const card = document.createElement("div");
    card.className = "event-card";
    const title = document.createElement("strong");
    title.textContent = task.status || "task";
    const detail = document.createElement("small");
    detail.textContent = task.description || task.id || "";
    card.append(title, detail);
    els.taskList.append(card);
  }
}

function showModal(modal) {
  const question = modal.question || `${modal.tool_name || "이 도구"} 실행을 허용할까요?`;
  els.modalHost.classList.remove("hidden");
  els.modalHost.textContent = "";

  const card = document.createElement("div");
  card.className = "modal-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");

  const title = document.createElement("h2");
  title.textContent = modal.kind === "question" ? "질문" : "권한 요청";
  const body = document.createElement("p");
  body.textContent = question;
  const actions = document.createElement("div");
  actions.className = "modal-actions";

  card.append(title, body);

  if (modal.kind === "question") {
    const input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = "답변을 입력하세요...";
    const submit = modalButton("제출", true, () => {
      respond({ type: "question_response", request_id: modal.request_id, answer: input.value });
    });
    actions.append(submit);
    card.append(input, actions);
    els.modalHost.append(card);
    input.focus();
    return;
  }

  actions.append(
    modalButton("거부", false, () =>
      respond({ type: "permission_response", request_id: modal.request_id, allowed: false }),
    ),
    modalButton("허용", true, () =>
      respond({ type: "permission_response", request_id: modal.request_id, allowed: true }),
    ),
  );
  card.append(actions);
  els.modalHost.append(card);
}

function showSelect(event) {
  const modal = event.modal || {};
  els.modalHost.classList.remove("hidden");
  els.modalHost.textContent = "";

  const card = document.createElement("div");
  card.className = "modal-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");

  const title = document.createElement("h2");
  title.textContent = modal.title || "선택";
  card.append(title);

  for (const option of event.select_options || []) {
    const button = modalButton(option.label || option.value, false, () => {
      respond({ type: "apply_select_command", command: modal.command, value: option.value });
    });
    button.title = option.description || "";
    card.append(button);
  }

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  actions.append(modalButton("취소", false, closeModal));
  card.append(actions);
  els.modalHost.append(card);
}

function modalButton(label, primary, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (primary) {
    button.classList.add("primary");
  }
  button.addEventListener("click", onClick);
  return button;
}

async function respond(payload) {
  closeModal();
  await postJson("/api/respond", { sessionId: state.sessionId, payload });
}

function closeModal() {
  els.modalHost.classList.add("hidden");
  els.modalHost.textContent = "";
}

function autoSizeInput() {
  els.input.style.height = "auto";
  els.input.style.height = `${Math.min(190, els.input.scrollHeight)}px`;
}

els.composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await sendLine(els.input.value);
  } catch (error) {
    appendMessage("system", `전송 실패: ${error.message}`);
    setBusy(false, STATUS_LABELS.error);
  }
});

els.input.addEventListener("input", () => {
  autoSizeInput();
  updateSendState();
  state.slashMenuIndex = 0;
  updateSlashMenu();
});

els.input.addEventListener("keydown", (event) => {
  if (state.slashMenuOpen && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(event.key)) {
    const commands = filteredSlashCommands();
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      state.slashMenuIndex = (state.slashMenuIndex + 1) % commands.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      state.slashMenuIndex = (state.slashMenuIndex - 1 + commands.length) % commands.length;
      renderSlashMenu();
      return;
    }
    if (event.key === "Enter" || event.key === "Tab") {
      event.preventDefault();
      selectSlashCommand(commands[state.slashMenuIndex]);
      return;
    }
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.composer.requestSubmit();
  }
});

els.input.addEventListener("click", updateSlashMenu);

els.input.addEventListener("blur", () => {
  window.setTimeout(closeSlashMenu, 120);
});

els.messages.addEventListener("scroll", () => {
  if (!state.restoringHistory && !state.ignoreScrollSave) {
    state.autoFollowMessages = isNearMessageBottom();
  }
  scheduleScrollPositionSave();
});

window.addEventListener("keydown", (event) => {
  if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "o") {
    event.preventDefault();
    closeSlashMenu();
    clearChat().catch((error) => appendMessage("system", `채팅을 초기화하지 못했습니다: ${error.message}`));
  }
});

document.querySelectorAll("[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    const prompt = button.dataset.prompt || "";
    sendLine(prompt).catch((error) => {
      appendMessage("system", `명령어 실행 실패: ${error.message}`);
      setBusy(false, STATUS_LABELS.error);
    });
  });
});

document.querySelectorAll("[data-action='refresh-history']").forEach((button) => {
  button.addEventListener("click", () => {
    requestHistory().catch((error) => appendMessage("system", `기록을 불러오지 못했습니다: ${error.message}`));
  });
});

document.querySelectorAll("[data-action='new-chat']").forEach((button) => {
  button.addEventListener("click", () => {
    clearChat().catch((error) => appendMessage("system", `채팅을 초기화하지 못했습니다: ${error.message}`));
  });
});

startSession().catch((error) => {
  appendMessage("system", `백엔드 시작 실패: ${error.message}`);
  setStatus(STATUS_LABELS.startFailed);
});

window.addEventListener("beforeunload", () => {
  if (!state.sessionId) {
    return;
  }
  navigator.sendBeacon(
    "/api/shutdown",
    new Blob([JSON.stringify({ sessionId: state.sessionId })], { type: "application/json" }),
  );
});
