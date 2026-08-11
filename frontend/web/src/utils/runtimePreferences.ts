import type { AppState, RuntimePickerOption } from "../types/ui";

const runtimePreferenceKey = "myharness:runtimePreferences";
const runtimePreferenceVersion = 2;
const defaultActiveProfile = "p-gpt";

export type RuntimePreferences = {
  activeProfile?: string;
  model?: string;
  subagentModel?: string;
  subagentEffort?: string;
  effort?: string;
  gpt56ContextMode?: "cost-saver" | "full-context";
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
    const value = JSON.parse(localStorage.getItem(runtimePreferenceKey) || "{}") as RuntimePreferences & {
      version?: number;
    };
    const appSettings = JSON.parse(localStorage.getItem("myharness:appSettings") || "{}") as {
      gpt56ContextMode?: string;
    };
    const activeProfile = normalizeActiveProfile(value.activeProfile) || defaultActiveProfile;
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
      activeProfile: defaultActiveProfile,
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

export function runtimePreferencesFromState(state: Pick<AppState, "provider" | "activeProfile" | "model" | "subagentModel" | "subagentEffort" | "effort" | "appSettings">): RuntimePreferences {
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
