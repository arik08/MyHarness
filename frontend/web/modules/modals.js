export function createModals(ctx) {
  const { state, els } = ctx;
  function requestSelectCommand(...args) { return ctx.requestSelectCommand(...args); }
  function appendMessage(...args) { return ctx.appendMessage(...args); }
  function respond(...args) { return ctx.respond(...args); }
  function postJson(...args) { return ctx.postJson(...args); }

function showSettingsModal() {
  els.modalHost.classList.remove("hidden");
  els.modalHost.textContent = "";
  els.modalHost.dataset.dismissible = "true";
  delete els.modalHost.dataset.dismissAction;

  const card = document.createElement("div");
  card.className = "modal-card settings-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.append(modalCloseButton(closeModal));

  const title = document.createElement("h2");
  title.textContent = "설정";
  const body = document.createElement("p");
  body.textContent = "Provider, 모델, 추론 노력을 변경할 수 있습니다.";
  card.append(title, body);

  const list = document.createElement("div");
  list.className = "settings-list";
  list.append(
    settingsButton("Provider", state.provider, () => {
      closeModal();
      state.returnToSettingsOnDismiss = true;
      requestSelectCommand("provider").catch((error) => appendMessage("system", `Selection failed: ${error.message}`));
    }),
    settingsButton("모델", state.model, () => {
      closeModal();
      state.returnToSettingsOnDismiss = true;
      requestSelectCommand("model").catch((error) => appendMessage("system", `Selection failed: ${error.message}`));
    }),
    settingsButton("추론 노력", state.effort, () => {
      closeModal();
      state.returnToSettingsOnDismiss = true;
      requestSelectCommand("effort").catch((error) => appendMessage("system", `Selection failed: ${error.message}`));
    }),
  );
  card.append(list);

  els.modalHost.append(card);
}

function settingsButton(label, value, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "settings-row";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = label;
  const current = document.createElement("small");
  current.textContent = value || "-";
  copy.append(title, current);
  const arrow = document.createElement("span");
  arrow.className = "settings-row-arrow";
  arrow.setAttribute("aria-hidden", "true");
  arrow.textContent = ">";
  button.append(copy, arrow);
  button.addEventListener("click", onClick);
  return button;
}

function showModal(modal) {
  const question = modal.question || `${modal.tool_name || "이 도구"} 실행을 허용할까요?`;
  els.modalHost.classList.remove("hidden");
  els.modalHost.textContent = "";
  delete els.modalHost.dataset.dismissible;
  delete els.modalHost.dataset.dismissAction;

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
  els.modalHost.dataset.dismissible = "true";
  delete els.modalHost.dataset.dismissAction;
  if (state.returnToSettingsOnDismiss) {
    els.modalHost.dataset.dismissAction = "settings";
    state.returnToSettingsOnDismiss = false;
  }

  const card = document.createElement("div");
  card.className = "modal-card select-card";
  card.setAttribute("role", "dialog");
  card.setAttribute("aria-modal", "true");
  card.append(modalCloseButton(closeModal));

  const title = document.createElement("h2");
  title.textContent = modal.title || "선택";
  const body = document.createElement("p");
  body.textContent = "현재 세션에 적용할 값을 선택하세요.";
  card.append(title, body);

  const list = document.createElement("div");
  list.className = "select-list";
  for (const option of event.select_options || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `select-option${option.active ? " active" : ""}`;
    button.addEventListener("click", () => {
      const returnToSettings = els.modalHost.dataset.dismissAction === "settings";
      respond({ type: "apply_select_command", command: modal.command, value: option.value });
      if (returnToSettings) {
        window.setTimeout(showSettingsModal, 0);
      }
    });
    button.title = option.description || "";
    const copy = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = option.label || option.value;
    const description = document.createElement("small");
    description.textContent = option.description || option.value || "";
    copy.append(label, description);
    const check = document.createElement("span");
    check.className = "select-check";
    check.setAttribute("aria-hidden", "true");
    check.textContent = option.active ? "✓" : "";
    button.append(copy, check);
    list.append(button);
  }
  card.append(list);

  els.modalHost.append(card);
}

function modalCloseButton(onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "modal-close";
  button.setAttribute("aria-label", "닫기");
  button.innerHTML = `
    <svg aria-hidden="true" viewBox="0 0 24 24">
      <path d="M6 6l12 12"></path>
      <path d="M18 6L6 18"></path>
    </svg>
  `;
  button.addEventListener("click", onClick);
  return button;
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
  state.returnToSettingsOnDismiss = false;
  els.modalHost.classList.add("hidden");
  els.modalHost.textContent = "";
  delete els.modalHost.dataset.dismissible;
  delete els.modalHost.dataset.dismissAction;
}

  return {
    showSettingsModal,
    settingsButton,
    showModal,
    showSelect,
    modalCloseButton,
    modalButton,
    respond,
    closeModal,
  };
}
