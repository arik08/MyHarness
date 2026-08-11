import { afterEach, describe, expect, it } from "vitest";
import { initialAppState } from "../../state/reducer";
import { loadRuntimePreferences, rememberRuntimeChoice, runtimePreferencesFromState } from "../runtimePreferences";

describe("runtime preference utilities", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("uses the backend active profile id instead of the detected provider name", () => {
    const preferences = runtimePreferencesFromState({
      provider: "openai-codex",
      activeProfile: "codex",
      model: "gpt-5.5",
      subagentModel: "gpt-5.4-mini",
      subagentEffort: "medium",
      effort: "low",
      appSettings: initialAppState.appSettings,
    });

    expect(preferences.activeProfile).toBe("codex");
    expect(preferences.gpt56ContextMode).toBe("cost-saver");
  });

  it("defaults to P-GPT when no provider choice has been stored", () => {
    expect(loadRuntimePreferences().activeProfile).toBe("p-gpt");
  });

  it("keeps the last explicitly selected provider", () => {
    rememberRuntimeChoice("provider", {
      value: "codex",
      label: "Codex",
      description: "ChatGPT OAuth",
      active: false,
    });

    expect(loadRuntimePreferences().activeProfile).toBe("codex");
    expect(JSON.parse(localStorage.getItem("myharness:runtimePreferences") || "{}")).toMatchObject({
      version: 2,
      activeProfile: "codex",
    });
  });

  it("normalizes stale detected provider names stored as active profiles", () => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({
      activeProfile: "openai-codex",
      model: "gpt-5.5",
      subagentModel: "gpt-5.4-mini",
      effort: "high",
    }));

    expect(loadRuntimePreferences()).toMatchObject({
      activeProfile: "codex",
      model: undefined,
      subagentModel: undefined,
      effort: "high",
    });
    expect(JSON.parse(localStorage.getItem("myharness:runtimePreferences") || "{}")).toMatchObject({
      version: 2,
      activeProfile: "codex",
      effort: "high",
    });
  });

  it("preserves current-version model choices", () => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({
      version: 2,
      activeProfile: "codex",
      model: "gpt-5.6-sol",
      subagentModel: "gpt-5.6-luna",
    }));

    expect(loadRuntimePreferences()).toMatchObject({
      activeProfile: "codex",
      model: "gpt-5.6-sol",
      subagentModel: "gpt-5.6-luna",
    });
  });

  it("loads the per-browser GPT-5.6 full-context preference", () => {
    localStorage.setItem("myharness:appSettings", JSON.stringify({
      gpt56ContextMode: "full-context",
    }));

    expect(loadRuntimePreferences().gpt56ContextMode).toBe("full-context");
  });
});
