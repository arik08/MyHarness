import { useEffect, useState } from "react";
import { useAppState } from "../state/app-state";
import { isResponseVisiblyBusy } from "../state/selectors";
import type { StatusKind } from "../types/ui";

type DisplayStatus = {
  busy: boolean;
  status: StatusKind;
  statusText: string;
};

function modeFor(display: DisplayStatus) {
  return display.status === "ready" && !display.busy ? "ready" : display.busy || display.status === "processing" ? "busy" : "";
}

export function StatusPill() {
  const { state } = useAppState();
  const [restoreStatusVisible, setRestoreStatusVisible] = useState(false);
  useEffect(() => {
    setRestoreStatusVisible(false);
    if (!state.restoringHistory) return;
    const timer = window.setTimeout(() => setRestoreStatusVisible(true), 300);
    return () => window.clearTimeout(timer);
  }, [state.restoringHistory, state.pendingHistoryId]);

  const display = isResponseVisiblyBusy(state)
    ? { busy: true, status: state.status, statusText: state.statusText }
    : state.busy
      ? { busy: false, status: "ready" as const, statusText: "답변 완료" }
      : { busy: false, status: state.status, statusText: state.statusText };

  const mode = modeFor(display);
  if (state.restoringHistory && !restoreStatusVisible) return null;
  return (
    <div className={`status-pill ${mode}`.trim()} id="readyPill">
      {display.statusText}
    </div>
  );
}
