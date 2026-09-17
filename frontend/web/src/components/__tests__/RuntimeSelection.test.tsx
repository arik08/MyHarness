import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ComposerRuntimeControls } from "../ComposerRuntimeControls";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";
import { runtimePreferencesFromState } from "../../utils/runtimePreferences";
import type { BackendEvent } from "../../types/backend";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); });
let dispatch: ReturnType<typeof useAppState>["dispatch"];
function Probe() {
  const context = useAppState();
  dispatch = context.dispatch;
  return <output>{JSON.stringify(runtimePreferencesFromState(context.state))}</output>;
}
function setup() {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", activeProfile: "p", model: "old", effort: "low", runtimePicker: {
    ...initialAppState.runtimePicker, providers: [{ value: "p", label: "Provider" }],
    modelsByProvider: { p: [{ value: "old", label: "Old" }, { value: "new", label: "New" }, { value: "future", label: "Future" }] },
    efforts: [{ value: "low", label: "Low" }, { value: "high", label: "High" }],
  } }}><ComposerRuntimeControls /><Probe /></AppStateProvider>);
}
function select(menu: string, choice: string) {
  fireEvent.click(screen.getByRole("button", { name: menu }));
  fireEvent.click(screen.getByRole("button", { name: choice }));
}
function snapshot(state: { model?: string; effort?: string }, index?: number) {
  const request_id = index === undefined ? undefined : String(vi.mocked(sendBackendRequest).mock.calls[index][2].request_id);
  act(() => dispatch({ type: "backend_event", event: { type: "state_snapshot", state, request_id } as BackendEvent }));
}

it("sends and confirms model and effort changes without randomUUID on LAN HTTP", async () => {
  vi.stubGlobal("crypto", { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) });
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  setup();
  select("추론 노력도", "High");
  select("모델 선택", "Future");
  await act(async () => {});
  const calls = vi.mocked(sendBackendRequest).mock.calls;
  expect(calls[0][2]).toMatchObject({ type: "apply_select_command", command: "effort", value: "high", request_id: expect.any(String) });
  expect(calls[1][2]).toMatchObject({ command: "runtime_model", value: JSON.stringify({ profile: "p", model: "future" }) });
  expect(calls[0][2].request_id).not.toBe(calls[1][2].request_id);
  snapshot({ model: "old", effort: "high" }, 0);
  snapshot({ model: "future", effort: "high" }, 1);
  expect(screen.getByRole("button", { name: "추론 노력도" }).textContent).toContain("High");
  expect(screen.getByRole("button", { name: "추론 노력도" }).hasAttribute("disabled")).toBe(false);
  expect(screen.getByRole("status").textContent).toContain('"effort":"high"');
});

it("shows rapid model and effort choices before HTTP or backend completion and ignores stale snapshots", () => {
  vi.mocked(sendBackendRequest).mockImplementation(() => new Promise(() => {}));
  setup();
  select("모델 선택", "New");
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).toContain("New");
  select("추론 노력도", "High");
  select("모델 선택", "Future");
  snapshot({ model: "old", effort: "low" });
  snapshot({ model: "new", effort: "low" }, 0);
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).toContain("Future");
  expect(screen.getByRole("button", { name: "추론 노력도" }).textContent).toContain("High");
  expect(screen.getByRole("status").textContent).toContain('"model":"future"');
  snapshot({ model: "new", effort: "high" }, 1);
  snapshot({ model: "future", effort: "high" }, 2);
  snapshot({ model: "old", effort: "low" });
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).toContain("Old");
});

it("rolls back transport failures without dropping another pending choice", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(sendBackendRequest).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue({ ok: true });
  setup();
  select("모델 선택", "New");
  select("추론 노력도", "High");
  await act(async () => reject(new Error("offline")));
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).toContain("Old");
  expect(screen.getByRole("button", { name: "추론 노력도" }).textContent).toContain("High");
  expect(screen.getByRole("alert").textContent).toContain("offline");
});

it("uses the confirmed runtime after backend rejection and never overlays another session", async () => {
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  setup();
  select("모델 선택", "Future");
  await act(async () => {});
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).toContain("Future");
  snapshot({ model: "old", effort: "low" }, 0);
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).toContain("Old");
  select("모델 선택", "New");
  act(() => dispatch({ type: "session_started", sessionId: "other" }));
  expect(screen.getByRole("button", { name: "모델 선택" }).textContent).not.toContain("New");
});
