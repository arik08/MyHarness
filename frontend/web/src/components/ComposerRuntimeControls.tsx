import { useState } from "react";
import { sendBackendRequest } from "../api/messages";
import { useAppState } from "../state/app-state";
import { rememberRuntimeChoice } from "../utils/runtimePreferences";
import type { RuntimePickerOption } from "../types/ui";
import { ComposerChoice, ComposerIcon, ComposerMenu } from "./ComposerMenu";

export function ComposerRuntimeControls() {
  const { state } = useAppState();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const disabled = !state.sessionId || state.busy || pending || state.runtimeChoicePending;
  const latestUsage = [...state.messages].reverse().find((message) => message.usage)?.usage;
  const maximum = state.runtimePicker.contextModeAvailable && state.appSettings.gpt56ContextMode === "full-context";
  const contextWindow = maximum ? state.runtimePicker.contextWindow : state.runtimePicker.standardContextWindow;
  const usedTokens = Math.max(0, latestUsage?.input_tokens || 0);
  const usagePercent = contextWindow ? Math.min(100, Math.round(usedTokens / contextWindow * 100)) : 0;
  const modelLabel = state.runtimePicker.models.find((model) => model.value === state.model)?.label || (state.model !== "-" && state.model) || "모델";

  async function select(command: "model" | "effort", option: RuntimePickerOption, profile?: string) {
    if (!state.sessionId || disabled) return;
    setPending(true);
    setError("");
    try {
      await sendBackendRequest(state.sessionId, state.clientId, {
        type: "apply_select_command", command: profile ? "runtime_model" : command,
        value: profile ? JSON.stringify({ profile, model: option.value }) : option.value,
      });
      if (profile) rememberRuntimeChoice("provider", state.runtimePicker.providers.find((item) => item.value === profile) || { value: profile, label: profile });
      rememberRuntimeChoice(command, option);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(false); }
  }

  async function changeContext(mode: "cost-saver" | "full-context") {
    if (!state.sessionId || disabled || state.appSettings.gpt56ContextMode === mode) return;
    setPending(true);
    setError("");
    try {
      await sendBackendRequest(state.sessionId, state.clientId, { type: "apply_select_command", command: "context_mode", value: mode });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally { setPending(false); }
  }

  return <>
    <button type="button" className={`composer-tool context-usage-trigger${maximum ? " is-maximum" : ""}`}
      aria-label={`컨텍스트 ${contextWindow ? formatContextTokens(contextWindow) : ""} 모드, ${usagePercent}% 사용`}
      aria-pressed={Boolean(maximum)} disabled={disabled || !state.runtimePicker.contextModeAvailable}
      data-tooltip="컨텍스트 길이:" data-tooltip-placement="top" data-tooltip-immediate="true"
      data-context-usage={contextWindow ? `${usagePercent}% 사용 (${100 - usagePercent}% 남음)` : "용량을 불러오는 중입니다."}
      data-tooltip-description={contextWindow ? `${formatContextTokens(usedTokens)} / ${formatContextTokens(contextWindow)} 토큰 사용` : ""}
      data-context-warning={maximum ? "주의: 1M 모드는 비용이 2배입니다." : ""}
      onClick={() => void changeContext(maximum ? "cost-saver" : "full-context")}>
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <circle className="context-usage-track" cx="10" cy="10" r="7.5" />
        <circle className="context-usage-progress" cx="10" cy="10" r="7.5" pathLength="100" strokeDasharray="100" strokeDashoffset={100 - usagePercent} />
      </svg>
    </button>
    <ComposerMenu label="모델 선택" icon={/^(?:openai[/:])?(?:gpt-|chatgpt-|o[1-9](?:-|$))/i.test(state.model) ? <ComposerIcon name="openai" /> : undefined} text={modelLabel} compact disabled={disabled}>
      {(close) => <>
        {state.runtimePicker.providers.map((provider) => {
          const models = state.runtimePicker.modelsByProvider[provider.value] || [];
          if (!models.length) return null;
          return <div key={provider.value}>
            <span className="composer-model-provider">{provider.label}</span>
            {models.map((option) => <ComposerChoice key={option.value} label={option.label} selected={option.value === state.model && provider.value === (state.activeProfile || state.provider)} onClick={() => { close(); void select("model", option, provider.value); }} />)}
          </div>;
        })}
        {!state.runtimePicker.models.length && <p className="composer-menu-description">선택 가능한 모델을 불러오는 중입니다.</p>}
      </>}
    </ComposerMenu>
    <ComposerMenu label="추론 노력도" text={state.effort && !["-", "none", "auto"].includes(state.effort) ? state.effort.charAt(0).toUpperCase() + state.effort.slice(1) : "Auto"} chevron compact disabled={disabled}>
      {(close) => <>
        {state.runtimePicker.efforts.map((option) => <ComposerChoice key={option.value} label={option.label} selected={option.value === state.effort} onClick={() => { close(); void select("effort", option); }} />)}
        {!state.runtimePicker.efforts.length && <p className="composer-menu-description">이 모델은 별도의 추론 설정을 제공하지 않습니다.</p>}
      </>}
    </ComposerMenu>
    {error && <span className="composer-runtime-error" role="alert">{error}</span>}
  </>;
}

function formatContextTokens(value: number) {
  if (value < 1_000) return value.toLocaleString("ko-KR");
  if (value >= 1_000_000) {
    const millions = Math.floor(value / 100_000) / 10;
    return `${millions.toFixed(Number.isInteger(millions) ? 0 : 1)}M`;
  }
  const thousands = value / 1_000;
  return `${thousands >= 10 || Number.isInteger(thousands) ? thousands.toFixed(0) : thousands.toFixed(1)}k`;
}
