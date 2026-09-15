import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ModelAvailabilityMenu } from "../ModelAvailabilityMenu";
import { ComposerRuntimeControls } from "../ComposerRuntimeControls";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { getJson, postJson } from "../../api/http";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/http", () => ({ getJson: vi.fn(), postJson: vi.fn() }));
vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));
const options = {
  providers: [{ value: "a", label: "Provider A" }, { value: "b", label: "Provider B" }],
  all_models_by_provider: { a: [{ value: "one", label: "One", enabled: true }, { value: "two", label: "Two", enabled: true }], b: [{ value: "one", label: "Other One", enabled: true }] },
  models_by_provider: { a: [{ value: "one", label: "One" }, { value: "two", label: "Two" }], b: [{ value: "one", label: "Other One" }] },
};
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getJson).mockResolvedValue(options); });
afterEach(cleanup);
function Probe() {
  const { state } = useAppState();
  return <output aria-label="runtime">{state.activeProfile}:{state.model}:{String(state.busy)}</output>;
}
function setup(busy = false) {
  const anchorRef = createRef<HTMLButtonElement>();
  return render(<AppStateProvider initialState={{ ...initialAppState, adminMode: true, activeProfile: "a", model: "one", busy }}>
    <button ref={anchorRef}>anchor</button><ModelAvailabilityMenu anchorRef={anchorRef} onClose={vi.fn()} /><Probe />
  </AppStateProvider>);
}
it.each([false, true])("persists checkbox changes without switching the active runtime while busy=%s", async (busy) => {
  const updated = { ...options, all_models_by_provider: { ...options.all_models_by_provider, a: options.all_models_by_provider.a.map(m => ({ ...m, enabled: m.value !== "two" })) }, models_by_provider: { ...options.models_by_provider, a: options.models_by_provider.a.slice(0, 1) } };
  vi.mocked(postJson).mockResolvedValue(updated);
  setup(busy);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Two" }));
  await waitFor(() => expect((screen.getByRole("checkbox", { name: "Two" }) as HTMLInputElement).checked).toBe(false));
  expect(postJson).toHaveBeenCalledWith("/api/settings/models", { profile: "a", model: "two", enabled: false });
  expect(screen.getByLabelText("runtime").textContent).toBe(`a:one:${busy}`);
  expect(sendBackendRequest).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Provider B/ }));
  expect(screen.getByRole("checkbox", { name: "Other One" })).toBeTruthy();
});
it("keeps the saved checkbox state when the server rejects a change", async () => {
  vi.mocked(postJson).mockRejectedValue(new Error("연결 오류"));
  setup();
  fireEvent.click(await screen.findByRole("checkbox", { name: "One" }));
  expect((await screen.findByRole("alert")).textContent).toContain("연결 오류");
  expect((screen.getByRole("checkbox", { name: "One" }) as HTMLInputElement).checked).toBe(true);
});
it("selects provider and model together from the composer", async () => {
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session", activeProfile: "a", model: "one", runtimePicker: {
    ...initialAppState.runtimePicker, providers: options.providers, modelsByProvider: options.models_by_provider, models: options.models_by_provider.a,
  } }}><ComposerRuntimeControls /></AppStateProvider>);
  fireEvent.click(screen.getByRole("button", { name: "모델 선택" }));
  fireEvent.click(screen.getByRole("button", { name: "Other One" }));
  await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith("session", expect.any(String), { type: "apply_select_command", command: "runtime_model", value: JSON.stringify({ profile: "b", model: "one" }) }));
});

it("keeps rapid input enabled and overlays pending changes on old responses", async () => {
  let finish!: (value: typeof options) => void;
  vi.mocked(postJson).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(options);
  setup();
  const one = await screen.findByRole("checkbox", { name: "One" }) as HTMLInputElement;
  const two = screen.getByRole("checkbox", { name: "Two" }) as HTMLInputElement;
  fireEvent.click(one);
  fireEvent.click(two);
  expect(one.checked).toBe(false);
  expect(two.checked).toBe(false);
  expect(two.disabled).toBe(false);
  expect(postJson).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("checkbox", { name: "Provider B 전체 선택" }));
  await act(async () => finish(options));
  await waitFor(() => expect(postJson).toHaveBeenCalledTimes(3));
  expect(vi.mocked(postJson).mock.calls.map(call => call[1])).toEqual([
    { profile: "a", model: "one", enabled: false },
    { profile: "a", model: "two", enabled: false },
    { profile: "b", enabled: false },
  ]);
});
it("bulk selection updates all visible checkboxes immediately and supports partial state", async () => {
  vi.mocked(postJson).mockImplementation(() => new Promise(() => {}));
  setup();
  const all = await screen.findByRole("checkbox", { name: "Provider A 전체 선택" }) as HTMLInputElement;
  fireEvent.click(screen.getByRole("checkbox", { name: "One" }));
  expect(all.indeterminate).toBe(true);
  fireEvent.click(all);
  expect(all.checked).toBe(true);
  expect(all.indeterminate).toBe(false);
  fireEvent.click(all);
  expect((screen.getByRole("checkbox", { name: "One" }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole("checkbox", { name: "Two" }) as HTMLInputElement).checked).toBe(false);
});

it("rolls back only the failed change and keeps later edits while saving", async () => {
  let rejectFirst!: (reason: Error) => void;
  let finishSecond!: (value: typeof options) => void;
  vi.mocked(postJson)
    .mockImplementationOnce(() => new Promise((_, reject) => { rejectFirst = reject; }))
    .mockImplementationOnce(() => new Promise(resolve => { finishSecond = resolve; }));
  setup();
  const one = await screen.findByRole("checkbox", { name: "One" }) as HTMLInputElement;
  const two = screen.getByRole("checkbox", { name: "Two" }) as HTMLInputElement;
  fireEvent.click(one);
  fireEvent.click(two);
  await act(async () => rejectFirst(new Error("연결 오류")));
  expect(one.checked).toBe(true);
  expect(two.checked).toBe(false);
  expect(two.disabled).toBe(false);
  await act(async () => finishSecond({ ...options, all_models_by_provider: { ...options.all_models_by_provider,
    a: options.all_models_by_provider.a.map(model => ({ ...model, enabled: model.value !== "two" })),
  } }));
  expect(one.checked).toBe(true);
  expect(two.checked).toBe(false);
});
