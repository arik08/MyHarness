import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getJson, postJson } from "../../api/http";
import { DesignModeProvider } from "./DesignMode";
import { SettingsModal } from "../../components/SettingsModal";
import { Composer } from "../../components/Composer";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { sendBackendRequest, sendMessage, cancelMessage } from "../../api/messages";

vi.mock("../../api/messages", () => ({
  cancelMessage: vi.fn(), sendBackendRequest: vi.fn(), sendMessage: vi.fn(),
  uploadClientAttachments: vi.fn(),
}));

function SessionProbe() {
  const { state } = useAppState();
  return <output data-testid="session-state">{JSON.stringify({
    sessionId: state.sessionId, busy: state.busy, messages: state.messages,
    attachments: state.composer.attachments, draft: state.composer.draft,
  })}</output>;
}

function Fixture() {
  return (
    <AppStateProvider initialState={{
      ...initialAppState, adminMode: true, sessionId: "running-session", busy: true,
      messages: [{ id: "answer", role: "assistant", text: "작성 중인 답변", isComplete: false }],
      composer: { ...initialAppState.composer, draft: "추가 요청", attachments: [
        { name: "image.png", media_type: "image/png", data: "aGVsbG8=" },
      ] },
    }}>
      <DesignModeProvider>
        <Composer />
        <SettingsModal onClose={() => undefined} />
        <SessionProbe />
      </DesignModeProvider>
    </AppStateProvider>
  );
}

vi.mock("../../api/http", () => ({ getJson: vi.fn(), postJson: vi.fn() }));

describe("global design mode", () => {
  beforeEach(() => {
    localStorage.clear(); vi.clearAllMocks();
    vi.mocked(getJson).mockResolvedValue({ mode: "classic" });
    vi.mocked(postJson).mockImplementation(async (_url, body) => body);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); delete document.documentElement.dataset.theme; });

  async function ready() {
    await waitFor(() => expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(false));
  }

  it("saves globally without replacing input, session, draft or attachments", async () => {
    render(<Fixture />);
    await ready();
    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    const before = screen.getByTestId("session-state").textContent;
    fireEvent.click(screen.getByRole("switch"));
    await waitFor(() => expect(document.documentElement.dataset.designMode).toBe("improved"));
    expect(postJson).toHaveBeenCalledWith("/api/settings/design-mode", { mode: "improved" });
    expect(screen.getByPlaceholderText("메시지를 입력하세요...")).toBe(input);
    expect(screen.getByTestId("session-state").textContent).toBe(before);
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(cancelMessage).not.toHaveBeenCalled();
  });

  it("uses server state instead of browser preference and refreshes other clients on focus", async () => {
    localStorage.setItem("myharness:design-mode", "improved");
    document.documentElement.dataset.theme = "dark";
    render(<Fixture />);
    await ready();
    expect(document.documentElement.dataset.designMode).toBeUndefined();
    vi.mocked(getJson).mockResolvedValue({ mode: "improved" });
    fireEvent.focus(window);
    await waitFor(() => expect(document.documentElement.dataset.designMode).toBe("improved"));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("disables changes outside admin mode", async () => {
    render(<AppStateProvider initialState={{ ...initialAppState, adminMode: false }}>
      <DesignModeProvider><SettingsModal onClose={() => undefined} /></DesignModeProvider>
    </AppStateProvider>);
    await waitFor(() => expect(getJson).toHaveBeenCalled());
    expect(screen.getByRole("switch").hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    expect(postJson).not.toHaveBeenCalled();
  });

  it("automatically synchronizes an already open screen within three seconds", async () => {
    vi.useFakeTimers();
    try {
      render(<Fixture />);
      await act(async () => { await Promise.resolve(); });
      vi.mocked(getJson).mockResolvedValue({ mode: "improved" });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(document.documentElement.dataset.designMode).toBe("improved");
      vi.mocked(getJson).mockResolvedValue({ mode: "classic" });
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(document.documentElement.dataset.designMode).toBeUndefined();
    } finally { vi.useRealTimers(); }
  });

  it("keeps the saved mode and reports failed writes", async () => {
    vi.mocked(postJson).mockRejectedValue(new Error("403"));
    render(<Fixture />);
    await ready();
    fireEvent.click(screen.getByRole("switch"));
    await screen.findByRole("alert");
    expect(document.documentElement.dataset.designMode).toBeUndefined();
  });

  it("changes the actual design before a delayed save and restores it on failure", async () => {
    let reject!: (error: Error) => void;
    vi.mocked(postJson).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(<Fixture />);
    await ready();
    fireEvent.click(screen.getByRole("switch"));
    expect(document.documentElement.dataset.designMode).toBe("improved");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    await act(async () => reject(new Error("offline")));
    expect(document.documentElement.dataset.designMode).toBeUndefined();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it("supports keyboard changes", async () => {
    render(<Fixture />);
    await ready();
    screen.getByRole("switch").focus();
    await userEvent.keyboard(" ");
    await waitFor(() => expect(document.documentElement.dataset.designMode).toBe("improved"));
  });
});
