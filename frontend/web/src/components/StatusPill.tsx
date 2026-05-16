import { useEffect, useMemo, useRef, useState } from "react";
import { useAppState } from "../state/app-state";
import type { StatusKind } from "../types/ui";

const restoreLoadingText = "대화 불러오는 중";
const restoreLoadingDelayMs = 500;

type DisplayStatus = {
  busy: boolean;
  status: StatusKind;
  statusText: string;
};

function modeFor(display: DisplayStatus) {
  return display.status === "ready" && !display.busy ? "ready" : display.busy || display.status === "processing" ? "busy" : "";
}

function immediateDisplay(state: DisplayStatus): DisplayStatus {
  if (state.statusText === restoreLoadingText) {
    return { busy: false, status: "ready", statusText: "준비됨" };
  }
  return { busy: state.busy, status: state.status, statusText: state.statusText };
}

export function StatusPill() {
  const { state } = useAppState();
  const [display, setDisplay] = useState<DisplayStatus>(() => immediateDisplay(state));
  const previousStableDisplayRef = useRef<DisplayStatus>(display);
  const latestDisplayRef = useRef<DisplayStatus>(display);
  const nextDisplay = useMemo(
    () => ({ busy: state.busy, status: state.status, statusText: state.statusText }),
    [state.busy, state.status, state.statusText],
  );
  latestDisplayRef.current = nextDisplay;

  useEffect(() => {
    if (state.statusText === restoreLoadingText) {
      return;
    }
    previousStableDisplayRef.current = nextDisplay;
    setDisplay(nextDisplay);
  }, [nextDisplay, state.statusText]);

  useEffect(() => {
    if (state.statusText !== restoreLoadingText) {
      return undefined;
    }
    setDisplay(previousStableDisplayRef.current);
    const timeoutId = window.setTimeout(() => {
      setDisplay(latestDisplayRef.current);
    }, restoreLoadingDelayMs);

    return () => window.clearTimeout(timeoutId);
  }, [state.statusText]);

  const mode = modeFor(display);
  return (
    <div className={`status-pill ${mode}`.trim()} id="readyPill">
      {display.statusText}
    </div>
  );
}
