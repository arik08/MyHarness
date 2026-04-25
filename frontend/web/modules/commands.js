export function createCommands(ctx) {
  const { state, els, commandDescription } = ctx;
  function autoSizeInput(...args) { return ctx.autoSizeInput(...args); }
  function updateSendState(...args) { return ctx.updateSendState(...args); }
  function setComposerTokenFromSelection(...args) { return ctx.setComposerTokenFromSelection(...args); }

function getSlashQuery() {
  const value = els.input.value;
  const beforeCursor = value.slice(0, els.input.selectionStart || 0);
  const trigger = beforeCursor[0] || "";
  if (!["/", "$"].includes(trigger) || beforeCursor.includes(" ")) {
    return null;
  }
  return {
    trigger,
    value: beforeCursor.slice(1).toLowerCase(),
  };
}

function filteredSlashCommands() {
  const query = getSlashQuery();
  if (query === null) {
    return [];
  }
  if (query.trigger === "$") {
    return state.skills
      .filter((skill) => {
        const haystack = `${skill.name} ${skill.description} ${skill.source || ""}`.toLowerCase();
        return haystack.includes(query.value);
      })
      .sort((left, right) => {
        const sourceRank = (skill) => {
          const source = String(skill.source || "").toLowerCase();
          if (source === "project" || source === "program") return 0;
          if (source === "user") return 1;
          if (source === "bundled") return 3;
          return 2;
        };
        return sourceRank(left) - sourceRank(right) || left.name.localeCompare(right.name);
      })
      .map((skill) => ({
        ...skill,
        name: `$${skill.name}`,
        kind: "skill",
      }))
      .slice(0, 12);
  }
  return state.commands
    .filter((command) => command.name.slice(1).toLowerCase().includes(query.value))
    .map((command) => ({ ...command, kind: "command" }))
    .slice(0, 12);
}

function closeSlashMenu() {
  state.slashMenuOpen = false;
  state.slashMenuIndex = 0;
  state.slashMenuMode = "command";
  els.slashMenu.classList.add("hidden");
  els.slashMenu.textContent = "";
}

function formatForcedSkillName(name) {
  return /\s/.test(name) ? `"${name.replaceAll('"', '\\"')}"` : name;
}

function selectSlashCommand(item) {
  const selected = item.kind === "skill"
    ? { ...item, name: `$${formatForcedSkillName(item.name.slice(1))}` }
    : item;
  if (setComposerTokenFromSelection(selected)) {
    closeSlashMenu();
    return;
  }
  els.input.value = `${selected.name} `;
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
    description.textContent =
      command.kind === "skill"
        ? command.description
        : commandDescription(command.name, command.description);
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
  if (query === null) {
    closeSlashMenu();
    return;
  }
  const hasItems = query.trigger === "$" ? state.skills.length > 0 : state.commands.length > 0;
  if (!hasItems) {
    closeSlashMenu();
    return;
  }
  state.slashMenuMode = query.trigger === "$" ? "skill" : "command";
  renderSlashMenu();
}

  return {
    getSlashQuery,
    filteredSlashCommands,
    closeSlashMenu,
    selectSlashCommand,
    renderSlashMenu,
    updateSlashMenu,
  };
}
