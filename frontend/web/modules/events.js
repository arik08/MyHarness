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
  function setMarkdown(...args) { return ctx.setMarkdown(...args); }
  function scrollMessagesToBottom(...args) { return ctx.scrollMessagesToBottom(...args); }
  function finishScrollRestore(...args) { return ctx.finishScrollRestore(...args); }
  function appendWorkflowEvent(...args) { return ctx.appendWorkflowEvent(...args); }
  function showModal(...args) { return ctx.showModal(...args); }
  function showSelect(...args) { return ctx.showSelect(...args); }
  function updateSlashMenu(...args) { return ctx.updateSlashMenu(...args); }

let streamingRenderTimer = 0;
let streamingLastRenderAt = 0;
let streamingFlushTimer = 0;
let streamingTextBuffer = "";
let streamingTextNode = null;
const STREAMING_FLUSH_INTERVAL_MS = 30;
const STREAMING_MARKDOWN_RENDER_DELAY_MS = 120;
const STREAMING_MARKDOWN_RENDER_INTERVAL_MS = 300;

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

function shouldRenderStreamingMarkdown(text) {
  return /(^|\n)(#{1,6}\s|[-*]\s|\d+\.\s|>\s|```|\|.*\||---\s*$)|\\[([]|\\[)]/.test(text);
}

function renderStreamingAssistant(immediate = false) {
  if (!state.assistantNode) {
    return;
  }
  window.clearTimeout(streamingRenderTimer);
  const render = () => {
    if (!state.assistantNode) {
      return;
    }
    setMarkdown(state.assistantNode, state.assistantNode.dataset.rawText || "");
    streamingTextNode = null;
    if (!state.restoringHistory && state.autoFollowMessages) {
      scrollMessagesToBottom();
    }
  };
  if (immediate) {
    render();
    return;
  }
  streamingRenderTimer = window.setTimeout(render, STREAMING_MARKDOWN_RENDER_DELAY_MS);
}

function flushStreamingText() {
  window.clearTimeout(streamingFlushTimer);
  streamingFlushTimer = 0;
  if (!state.assistantNode || !streamingTextBuffer) {
    return;
  }
  if (!streamingTextNode?.isConnected) {
    streamingTextNode = document.createTextNode("");
    state.assistantNode.append(streamingTextNode);
  }
  streamingTextNode.appendData(streamingTextBuffer);
  streamingTextBuffer = "";
  if (!state.restoringHistory && state.autoFollowMessages) {
    scrollMessagesToBottom();
  }
}

function scheduleStreamingFlush() {
  if (streamingFlushTimer) {
    return;
  }
  streamingFlushTimer = window.setTimeout(flushStreamingText, STREAMING_FLUSH_INTERVAL_MS);
}

function resetStreamingState() {
  window.clearTimeout(streamingFlushTimer);
  window.clearTimeout(streamingRenderTimer);
  streamingFlushTimer = 0;
  streamingRenderTimer = 0;
  streamingLastRenderAt = 0;
  streamingTextBuffer = "";
  streamingTextNode = null;
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
      if (state.chatTitle === "OpenHarness" && !userText.startsWith("/")) {
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
    }
    const message = event.message || "";
    const nextText = (state.assistantNode.dataset.rawText || "") + message;
    state.assistantNode.dataset.rawText = nextText;
    streamingTextBuffer += message;
    scheduleStreamingFlush();
    const now = performance.now();
    if (
      shouldRenderStreamingMarkdown(nextText) &&
      (message.includes("\n") || now - streamingLastRenderAt > STREAMING_MARKDOWN_RENDER_INTERVAL_MS)
    ) {
      streamingLastRenderAt = now;
      renderStreamingAssistant();
    }
    return;
  }

  if (event.type === "assistant_complete") {
    if (state.assistantNode) {
      flushStreamingText();
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

  return {
    handleEvent,
  };
}
