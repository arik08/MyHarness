import type { AppState, RuntimePickerOption } from "../types/ui";

const runtimePreferenceKey = "myharness:runtimePreferences";

export type RuntimePreferences = {
  activeProfile?: string;
  model?: string;
  effort?: string;
};

function clean(value: unknown) {
  const text = String(value || "").trim();
  return text && text !== "-" ? text : "";
}

export function loadRuntimePreferences(): RuntimePreferences {
  try {
    const value = JSON.parse(localStorage.getItem(runtimePreferenceKey) || "{}") as RuntimePreferences;
    return {
      activeProfile: clean(value.activeProfile) || undefined,
      model: clean(value.model) || undefined,
      effort: clean(value.effort) || undefined,
    };
  } catch {
    return {};
  }
}

function saveRuntimePreferences(preferences: RuntimePreferences) {
  const normalized: RuntimePreferences = {
    activeProfile: clean(preferences.activeProfile) || undefined,
    model: clean(preferences.model) || undefined,
    effort: clean(preferences.effort) || undefined,
  };
  try {
    localStorage.setItem(runtimePreferenceKey, JSON.stringify(normalized));
  } catch {
    // Embedded/private contexts may block localStorage.
  }
}

export function runtimePreferencesFromState(state: Pick<AppState, "provider" | "model" | "effort">): RuntimePreferences {
  return {
    activeProfile: clean(state.provider) || undefined,
    model: clean(state.model) || undefined,
    effort: clean(state.effort) || undefined,
  };
}

export function rememberRuntimeChoice(command: "provider" | "model" | "effort", option: RuntimePickerOption) {
  const current = loadRuntimePreferences();
  if (command === "provider") {
    saveRuntimePreferences({ ...current, activeProfile: option.value, model: undefined });
    return;
  }
  if (command === "model") {
    saveRuntimePreferences({ ...current, model: option.value });
    return;
  }
  saveRuntimePreferences({ ...current, effort: option.value });
}
