import { afterEach, describe, expect, it } from "vitest";
import { initialAppState } from "../../state/reducer";
import { loadRuntimePreferences, rememberRuntimeChoice, runtimePreferencesFromState } from "../runtimePreferences";

describe("runtime preference utilities", () => {
  it.each(["{broken", "null", "[]"])("keeps provider/model choices when app settings contain %s", (raw) => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({ version: 2, activeProfile: "custom-provider", model: "custom-model" }));
    localStorage.setItem("myharness:appSettings", raw);
    expect(loadRuntimePreferences()).toMatchObject({ activeProfile: "custom-provider", model: "custom-model" });
  });
  it.each(["{broken", "null"])("keeps valid context settings when runtime preferences contain %s", (raw) => {
    localStorage.setItem("myharness:runtimePreferences", raw);
    localStorage.setItem("myharness:appSettings", JSON.stringify({ gpt56ContextMode: "full-context" }));
    expect(loadRuntimePreferences().gpt56ContextMode).toBe("full-context");
  });
  it("rejects non-string runtime identifiers without losing valid fields", () => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({ version: 2, activeProfile: {}, model: ["custom-model"], subagentModel: true, effort: "high" }));
    expect(loadRuntimePreferences()).toMatchObject({ activeProfile: undefined, model: undefined, subagentModel: undefined, effort: "high" });
  });
  it.each(["constructor", "__proto__", "toString"])("preserves custom profile name %s as a string", (activeProfile) => {
    localStorage.setItem("myharness:runtimePreferences", JSON.stringify({ version: 2, activeProfile }));
    expect(loadRuntimePreferences().activeProfile).toBe(activeProfile);
  });
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

  it("defers to the backend profile when no provider choice has been stored", () => {
    expect(loadRuntimePreferences().activeProfile).toBeUndefined();
  });

  it("defers to the backend profile when browser preferences are invalid", () => {
    localStorage.setItem("myharness:runtimePreferences", "invalid json");
    expect(loadRuntimePreferences().activeProfile).toBeUndefined();
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
