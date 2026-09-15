import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ComposerRuntimeControls } from "../ComposerRuntimeControls";
import { TooltipLayer } from "../TooltipLayer";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn() }));
beforeEach(() => { vi.mocked(sendBackendRequest).mockReset(); });

function BackendAck() {
  const { state, dispatch } = useAppState();
  return <button onClick={() => dispatch({ type: "backend_event", event: { type: "state_snapshot", state: { runtime_options: {
    context_window: 1050000, standard_context_window: 272000, context_mode_available: true,
    context_mode: state.appSettings.gpt56ContextMode === "full-context" ? "cost-saver" : "full-context",
  } } } })}>ack</button>;
}

function setup(busy = false, available = true) {
  render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy,
    runtimePicker: { ...initialAppState.runtimePicker, contextWindow: 1_050_000, standardContextWindow: 272_000, contextModeAvailable: available },
    messages: [{ id: "m", role: "assistant", text: "done", usage: { input_tokens: 163718, output_tokens: 0, cached_input_tokens: 0, uncached_input_tokens: 163718, total_tokens: 163718 } }],
  }}><ComposerRuntimeControls /><TooltipLayer /><BackendAck /></AppStateProvider>);
  return screen.getByRole("button", { name: /컨텍스트/ });
}

it("shows Lumina usage on hover and toggles both ways without a menu", async () => {
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  const trigger = setup();
  fireEvent.pointerOver(trigger);
  expect(screen.getByRole("tooltip").textContent).toContain("60% 사용 (40% 남음)");
  expect(screen.getByRole("tooltip").textContent).toContain("164k / 272k 토큰 사용");
  fireEvent.click(trigger);
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByText("ack"));
  await waitFor(() => expect(trigger.getAttribute("aria-pressed")).toBe("true"));
  expect(sendBackendRequest).toHaveBeenCalledWith("s", expect.any(String), expect.objectContaining({ command: "context_mode", value: "full-context" }));
  await waitFor(() => expect(screen.getByRole("tooltip").textContent).toContain("1M 모드는 비용이 2배"));
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.click(screen.getByText("ack"));
  await waitFor(() => expect(trigger.getAttribute("aria-pressed")).toBe("false"));
  expect(sendBackendRequest).toHaveBeenLastCalledWith("s", expect.any(String), expect.objectContaining({ command: "context_mode", value: "cost-saver" }));
});

it("preserves mode and reports a failed change", async () => {
  vi.mocked(sendBackendRequest).mockRejectedValue(new Error("연결 실패"));
  const trigger = setup();
  fireEvent.click(trigger);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", "연결 실패");
  expect(trigger.getAttribute("aria-pressed")).toBe("false");
});

it.each([[true, true], [false, false]])("disables switching when busy=%s and supported=%s", (busy, available) => {
  const trigger = setup(busy, available);
  fireEvent.click(trigger);
  expect(sendBackendRequest).not.toHaveBeenCalled();
});
