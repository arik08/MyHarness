import { useAppState } from "../state/app-state";

export function StatusPill() {
  const { state } = useAppState();
  const mode = state.status === "ready" && !state.busy ? "ready" : state.busy || state.status === "processing" ? "busy" : "";
  return (
    <div className={`status-pill ${mode}`.trim()} id="readyPill">
      {state.statusText}
    </div>
  );
}
