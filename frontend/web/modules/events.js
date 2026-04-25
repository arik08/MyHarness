export function createEvents(ctx) {
  const { state, STATUS_LABELS, commandDescription, updateState } = ctx;
  function setStatus(...args) { return ctx.setStatus(...args); }
  function setBusy(...args) { return ctx.setBusy(...args); }
  function updateTasks(...args) { return ctx.updateTasks(...args); }
  function updateSendState(...args) { return ctx.updateSendState(...args); }
  function requestHistory(...args) { return ctx.requestHistory(...args); }
  function renderHistory(...args) { return ctx.renderHistory(...args); }
  function appendMessage(...args) { return ctx.appendMessage(...args); }
  function setChatTitle(...args) { return ctx.setChatTitle(...args); }
  function renderWelcome(...args) { return ctx.renderWelcome(...args); }
  function resetWorkflowPanel(...args) { return ctx.resetWorkflowPanel(...args); }
  function collapseWorkflowPanel(...args) { return ctx.collapseWorkflowPanel(...args); }
  function finalizeWorkflowSummary(...args) { return ctx.finalizeWorkflowSummary(...args); }
  function setMarkdown(...args) { return ctx.setMarkdown(...args); }
  function scrollMessagesToBottom(...args) { return ctx.scrollMessagesToBottom(...args); }
  function finishScrollRestore(...args) { return ctx.finishScrollRestore(...args); }
  function appendWorkflowEvent(...args) { return ctx.appendWorkflowEvent(...args); }
  function showModal(...args) { return ctx.showModal(...args); }
  function showSelect(...args) { return ctx.showSelect(...args); }
  function updateSlashMenu(...args) { return ctx.updateSlashMenu(...args); }

let streamingRenderTimer = 0;
let streamingFlushTimer = 0;
let streamingScrollTimer = 0;
let streamingTextBuffer = "";
let streamingLiveNode = null;
let streamingRenderedTextLength = 0;
let streamingDisplayStarted = false;
const STREAMING_FLUSH_INTERVAL_MS = 30;
const STREAMING_START_BUFFER_MS = 250;
const STREAMING_MARKDOWN_RENDER_DELAY_MS = 250;
const STREAMING_REVEAL_CHAR_DELAY_MS = 5;
const STREAMING_MIN_CHARS_PER_FLUSH = 2;
const STREAMING_MAX_CHARS_PER_FLUSH = 14;

function normalizeSkills(skills) {
  return Array.isArray(skills)
    ? skills
        .map((skill) => ({
          name: String(skill.name || "").trim(),
          description: String(skill.description || "").trim(),
          source: String(skill.source || "").trim(),
        }))
        .filter((skill) => skill.name)
        .sort((left, right) => left.name.localeCompare(right.name))
    : [];
}

function isStreamingTextNode(node) {
  const parent = node.parentElement;
  return Boolean(parent && !parent.closest(".code-copy"));
}

function countRenderedStreamingText(root) {
  if (!root) {
    return 0;
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isStreamingTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  let length = 0;
  while (walker.nextNode()) {
    length += Array.from(walker.currentNode.nodeValue || "").length;
  }
  return length;
}

function revealRenderedStreamingContent(startIndex, endIndex) {
  if (!state.assistantNode || endIndex <= startIndex) {
    return 0;
  }
  const walker = document.createTreeWalker(state.assistantNode, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return isStreamingTextNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const replacements = [];
  let cursor = 0;
  let revealIndex = 0;

  while (walker.nextNode() && cursor < endIndex) {
    const node = walker.currentNode;
    const chars = Array.from(node.nodeValue || "");
    const nextCursor = cursor + chars.length;
    if (nextCursor <= startIndex) {
      cursor = nextCursor;
      continue;
    }

    const localStart = Math.max(0, startIndex - cursor);
    const localEnd = Math.min(chars.length, endIndex - cursor);
    if (localEnd > localStart) {
      replacements.push({ node, chars, localStart, localEnd, revealOffset: revealIndex });
      revealIndex += localEnd - localStart;
    }
    cursor = nextCursor;
  }

  for (const replacement of replacements) {
    const fragment = document.createDocumentFragment();
    const before = replacement.chars.slice(0, replacement.localStart).join("");
    const after = replacement.chars.slice(replacement.localEnd).join("");
    if (before) {
      fragment.append(document.createTextNode(before));
    }
    const revealText = replacement.chars.slice(replacement.localStart, replacement.localEnd).join("");
    if (revealText) {
      const span = document.createElement("span");
      span.className = "stream-reveal-segment";
      span.style.animationDelay = `${replacement.revealOffset * STREAMING_REVEAL_CHAR_DELAY_MS}ms`;
      span.textContent = revealText;
      fragment.append(span);
    }
    if (after) {
      fragment.append(document.createTextNode(after));
    }
    replacement.node.replaceWith(fragment);
  }
  return revealIndex;
}

function keepStreamingTailVisible() {
  if (state.restoringHistory || !state.autoFollowMessages) {
    return;
  }
  if (streamingScrollTimer) {
    return;
  }
  streamingScrollTimer = window.setTimeout(() => {
    streamingScrollTimer = 0;
    if (!state.restoringHistory && state.autoFollowMessages) {
      scrollMessagesToBottom({ smooth: true, duration: 900 });
    }
  }, 160);
}

function renderStreamingAssistant(immediate = false, reveal = true) {
  if (!state.assistantNode) {
    return;
  }
  window.clearTimeout(streamingRenderTimer);
  const render = () => {
    streamingRenderTimer = 0;
    if (!state.assistantNode) {
      return;
    }
    const displayText = state.assistantNode.dataset.displayText || "";
    const previousLength = streamingRenderedTextLength;
    const rawText = state.assistantNode.dataset.rawText || "";
    setMarkdown(state.assistantNode, displayText);
    state.assistantNode.dataset.rawText = rawText;
    state.assistantNode.dataset.displayText = displayText;
    streamingLiveNode = null;
    streamingRenderedTextLength = countRenderedStreamingText(state.assistantNode);
    if (reveal) {
      revealRenderedStreamingContent(previousLength, streamingRenderedTextLength);
    }
    if (!state.restoringHistory && state.autoFollowMessages) {
      keepStreamingTailVisible();
    }
  };
  if (immediate) {
    render();
    return;
  }
  streamingRenderTimer = window.setTimeout(render, STREAMING_MARKDOWN_RENDER_DELAY_MS);
}

function flushStreamingText(options = {}) {
  const flushAll = Boolean(options.flushAll);
  window.clearTimeout(streamingFlushTimer);
  streamingFlushTimer = 0;
  if (!state.assistantNode || !streamingTextBuffer) {
    return;
  }
  if (!streamingLiveNode?.isConnected) {
    streamingLiveNode = document.createElement("span");
    streamingLiveNode.className = "stream-live-text";
    state.assistantNode.append(streamingLiveNode);
  }
  streamingDisplayStarted = true;
  const pendingChars = Array.from(streamingTextBuffer);
  const revealCount = flushAll
    ? pendingChars.length
    : Math.min(
        STREAMING_MAX_CHARS_PER_FLUSH,
        Math.max(STREAMING_MIN_CHARS_PER_FLUSH, Math.ceil(pendingChars.length / 10)),
      );
  const nextText = pendingChars.slice(0, revealCount).join("");
  const fragment = document.createDocumentFragment();
  const revealSegments = nextText.match(/\s+|[^\s]{1,12}/g) || [nextText];
  revealSegments.forEach((segment, index) => {
    const span = document.createElement("span");
    span.className = "stream-reveal-segment";
    span.style.animationDelay = `${index * STREAMING_REVEAL_CHAR_DELAY_MS}ms`;
    span.textContent = segment;
    fragment.append(span);
  });
  streamingLiveNode.append(fragment);
  state.assistantNode.dataset.displayText = `${state.assistantNode.dataset.displayText || ""}${nextText}`;
  streamingRenderedTextLength += pendingChars.slice(0, revealCount).length;
  streamingTextBuffer = pendingChars.slice(revealCount).join("");
  if (!state.restoringHistory && state.autoFollowMessages) {
    keepStreamingTailVisible();
  }
  if (streamingTextBuffer) {
    scheduleStreamingFlush();
  }
}

function scheduleStreamingFlush() {
  if (streamingFlushTimer) {
    return;
  }
  const delay = streamingDisplayStarted ? STREAMING_FLUSH_INTERVAL_MS : STREAMING_START_BUFFER_MS;
  streamingFlushTimer = window.setTimeout(flushStreamingText, delay);
}

function scheduleStreamingMarkdownRender() {
  if (streamingRenderTimer) {
    return;
  }
  renderStreamingAssistant(false, true);
}

function resetStreamingState() {
  window.clearTimeout(streamingFlushTimer);
  window.clearTimeout(streamingRenderTimer);
  window.clearTimeout(streamingScrollTimer);
  streamingFlushTimer = 0;
  streamingRenderTimer = 0;
  streamingScrollTimer = 0;
  streamingTextBuffer = "";
  streamingLiveNode = null;
  streamingRenderedTextLength = 0;
  streamingDisplayStarted = false;
}

function handleEvent(event) {
  if (event.type === "web_session") {
    setStatus(STATUS_LABELS.startingBackend);
    return;
  }

  if (event.type === "ready") {
    state.switchingWorkspace = false;
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
    state.skills = normalizeSkills(event.skills);
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

  if (event.type === "skills_snapshot") {
    state.skills = normalizeSkills(event.skills);
    updateSlashMenu();
    return;
  }

  if (event.type === "transcript_item" && event.item) {
    if (event.item.role === "user") {
      if (!String(event.item.text || "").trim()) {
        return;
      }
      return;
    }
    if (event.item.role === "system" && event.item.text === "Conversation cleared.") {
      return;
    }
    if (event.item.role === "system" && String(event.item.text || "").startsWith("Session restored")) {
      return;
    }
    if (event.item.role === "assistant") {
      if (!String(event.item.text || "").trim()) {
        return;
      }
      appendMessage("assistant", event.item.text || "");
      return;
    }
    if (event.item.role === "system" && String(event.item.text || "").startsWith("> ")) {
      const userText = String(event.item.text || "").slice(2);
      if (!userText.trim()) {
        return;
      }
      if (state.chatTitle === "MyHarness" && !userText.startsWith("/")) {
        setChatTitle(userText);
      }
      appendMessage("user", userText);
      return;
    }
    if (!String(event.item.text || "").trim()) {
      return;
    }
    appendMessage(event.item.role === "log" ? "log" : "system", event.item.text || "");
    return;
  }

  if (event.type === "clear_transcript") {
    resetStreamingState();
    renderWelcome();
    state.assistantNode = null;
    resetWorkflowPanel();
    return;
  }

  if (event.type === "assistant_delta") {
    if (!state.assistantNode) {
      state.assistantNode = appendMessage("assistant", "");
      state.assistantNode.classList.add("streaming-text");
      state.assistantNode.textContent = "";
      state.assistantNode.dataset.rawText = "";
      state.assistantNode.dataset.displayText = "";
      streamingRenderedTextLength = 0;
    }
    const message = event.message || "";
    const nextText = (state.assistantNode.dataset.rawText || "") + message;
    state.assistantNode.dataset.rawText = nextText;
    streamingTextBuffer += message;
    scheduleStreamingFlush();
    scheduleStreamingMarkdownRender();
    return;
  }

  if (event.type === "assistant_complete") {
    if (state.assistantNode) {
      flushStreamingText({ flushAll: true });
      resetStreamingState();
      state.assistantNode.classList.remove("streaming-text");
      setMarkdown(state.assistantNode, event.message || state.assistantNode.dataset.rawText || "");
      state.assistantNode = null;
    } else if (event.message) {
      appendMessage("assistant", event.message);
    }
    return;
  }

  if (event.type === "line_complete") {
    resetStreamingState();
    state.assistantNode = null;
    finalizeWorkflowSummary();
    collapseWorkflowPanel();
    if (state.restoringHistory) {
      requestAnimationFrame(finishScrollRestore);
    }
    setBusy(false, STATUS_LABELS.ready);
    requestHistory().catch(() => {});
    return;
  }

  if (event.type === "tool_started" || event.type === "tool_completed") {
    setBusy(true, STATUS_LABELS.processing);
    appendWorkflowEvent(event);
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
    state.switchingWorkspace = false;
    appendMessage("system", `오류: ${event.message || "알 수 없는 오류"}`);
    setBusy(false, STATUS_LABELS.error);
    return;
  }

  if (event.type === "shutdown") {
    state.switchingWorkspace = false;
    state.ready = false;
    setStatus(STATUS_LABELS.stopped);
    updateSendState();
  }
}

  return {
    handleEvent,
  };
}
