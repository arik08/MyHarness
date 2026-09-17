import type { AppState, RuntimePickerOption } from "../types/ui";

const runtimePreferenceKey = "myharness:runtimePreferences";
const runtimePreferenceVersion = 2;

export type RuntimePreferences = {
  activeProfile?: string;
  model?: string;
  subagentModel?: string;
  subagentEffort?: string;
  effort?: string;
  gpt56ContextMode?: "cost-saver" | "full-context";
};

function clean(value: unknown) {
  const text = typeof value === "string" ? value.trim() : "";
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
  return Object.prototype.hasOwnProperty.call(aliases, text) ? aliases[text] : text;
}

function readPreferenceRecord(key: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function loadRuntimePreferences(): RuntimePreferences {
  try {
    const value = readPreferenceRecord(runtimePreferenceKey);
    const appSettings = readPreferenceRecord("myharness:appSettings");
    // Let the backend use settings.json until the user chooses a provider.
    const activeProfile = normalizeActiveProfile(value.activeProfile) || undefined;
    const resetBuiltInModel = value.version !== runtimePreferenceVersion
      && (activeProfile === "codex" || activeProfile === "p-gpt");
    const preferences: RuntimePreferences = {
      activeProfile,
      model: resetBuiltInModel ? undefined : clean(value.model) || undefined,
      subagentModel: resetBuiltInModel ? undefined : clean(value.subagentModel) || undefined,
      subagentEffort: clean(value.subagentEffort) || undefined,
      effort: clean(value.effort) || undefined,
      gpt56ContextMode: appSettings.gpt56ContextMode === "full-context" ? "full-context" : "cost-saver",
    };
    if (value.version !== runtimePreferenceVersion) {
      saveRuntimePreferences(preferences);
    }
    return preferences;
  } catch {
    return {
      activeProfile: undefined,
      gpt56ContextMode: "cost-saver",
    };
  }
}

function saveRuntimePreferences(preferences: RuntimePreferences) {
  const normalized: RuntimePreferences = {
    activeProfile: normalizeActiveProfile(preferences.activeProfile) || undefined,
    model: clean(preferences.model) || undefined,
    subagentModel: clean(preferences.subagentModel) || undefined,
    subagentEffort: clean(preferences.subagentEffort) || undefined,
    effort: clean(preferences.effort) || undefined,
    gpt56ContextMode: preferences.gpt56ContextMode === "full-context" ? "full-context" : "cost-saver",
  };
  try {
    localStorage.setItem(runtimePreferenceKey, JSON.stringify({
      version: runtimePreferenceVersion,
      ...normalized,
    }));
  } catch {
    // Embedded/private contexts may block localStorage.
  }
}

export function runtimeStateWithPendingChoices<T extends Pick<AppState, "model" | "effort" | "activeProfile"> & Partial<Pick<AppState, "sessionId" | "pendingRuntimeChoices">>>(state: T): T {
  return (state.pendingRuntimeChoices || []).reduce((current, choice) => {
    if (choice.sessionId !== state.sessionId) return current;
    return choice.command === "model"
      ? { ...current, model: choice.value, activeProfile: choice.profile || current.activeProfile }
      : { ...current, effort: choice.value };
  }, state);
}

export function runtimePreferencesFromState(source: Pick<AppState, "provider" | "activeProfile" | "model" | "subagentModel" | "subagentEffort" | "effort" | "appSettings"> & Partial<Pick<AppState, "sessionId" | "pendingRuntimeChoices">>): RuntimePreferences {
  const state = runtimeStateWithPendingChoices(source);
  return {
    activeProfile: normalizeActiveProfile(state.activeProfile) || normalizeActiveProfile(state.provider) || undefined,
    model: clean(state.model) || undefined,
    subagentModel: clean(state.subagentModel) || undefined,
    subagentEffort: clean(state.subagentEffort) || undefined,
    effort: clean(state.effort) || undefined,
    gpt56ContextMode: state.appSettings.gpt56ContextMode,
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
