import type { AppState, RuntimePickerOption } from "../types/ui";

const runtimePreferenceKey = "myharness:runtimePreferences";

export type RuntimePreferences = {
  activeProfile?: string;
  model?: string;
  subagentModel?: string;
  subagentEffort?: string;
  effort?: string;
};

function clean(value: unknown) {
  const text = String(value || "").trim();
  return text && text !== "-" ? text : "";
}

function normalizeActiveProfile(value: unknown) {
  const text = clean(value);
  const aliases: Record<string, string> = {
    "github_copilot": "copilot",
    "openai-codex": "codex",
    "openai_codex": "codex",
    "pgpt": "p-gpt",
  };
  return aliases[text] || text;
}

export function loadRuntimePreferences(): RuntimePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(runtimePreferenceKey) || "{}") as RuntimePreferences;
    return {
      activeProfile: normalizeActiveProfile(value.activeProfile) || undefined,
      model: clean(value.model) || undefined,
      subagentModel: clean(value.subagentModel) || undefined,
      subagentEffort: clean(value.subagentEffort) || undefined,
      effort: clean(value.effort) || undefined,
    };
  } catch {
    return {};
  }
}

function saveRuntimePreferences(preferences: RuntimePreferences) {
  const normalized: RuntimePreferences = {
    activeProfile: normalizeActiveProfile(preferences.activeProfile) || undefined,
    model: clean(preferences.model) || undefined,
    subagentModel: clean(preferences.subagentModel) || undefined,
    subagentEffort: clean(preferences.subagentEffort) || undefined,
    effort: clean(preferences.effort) || undefined,
  };
  try {
    localStorage.setItem(runtimePreferenceKey, JSON.stringify(normalized));
  } catch {
    // Embedded/private contexts may block localStorage.
  }
}

export function runtimePreferencesFromState(state: Pick<AppState, "provider" | "activeProfile" | "model" | "subagentModel" | "subagentEffort" | "effort">): RuntimePreferences {
  return {
    activeProfile: normalizeActiveProfile(state.activeProfile) || normalizeActiveProfile(state.provider) || undefined,
    model: clean(state.model) || undefined,
    subagentModel: clean(state.subagentModel) || undefined,
    subagentEffort: clean(state.subagentEffort) || undefined,
    effort: clean(state.effort) || undefined,
  };
}

export function rememberRuntimeChoice(command: "provider" | "model" | "subagent_model" | "effort" | "subagent_effort", option: RuntimePickerOption) {
  const current = loadRuntimePreferences();
  if (command === "provider") {
    saveRuntimePreferences({ ...current, activeProfile: option.value, model: undefined });
    return;
  }
  if (command === "model") {
    saveRuntimePreferences({ ...current, model: option.value });
    return;
  }
  if (command === "subagent_model") {
    saveRuntimePreferences({ ...current, subagentModel: option.value });
    return;
  }
  if (command === "subagent_effort") {
    saveRuntimePreferences({ ...current, subagentEffort: option.value });
    return;
  }
  saveRuntimePreferences({ ...current, effort: option.value });
}
