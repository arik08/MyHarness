import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConcurrencyStatus } from "../ConcurrencyStatus";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { readServerMetrics, type ServerMetrics } from "../../api/serverMetrics";

vi.mock("../../api/settings", () => ({
  concurrencySettingsChangedEvent: "settings-changed",
  readConcurrencyStatus: vi.fn().mockResolvedValue({ activeUsers: 1, connectedScreens: 1, busySessions: 2, maxBusySessions: 8 }),
}));
vi.mock("../../api/serverMetrics", () => ({ readServerMetrics: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const metrics: ServerMetrics = {
  startedAt: Date.now(), sampledAt: Date.now(), intervalMs: 5000, windowMs: 900000,
  resources: { cpuPercent: 12.3, totalMemoryBytes: 32 * 1024 ** 3, availableMemoryBytes: 16 * 1024 ** 3, appMemoryBytes: 1024 ** 3, processCount: 6, partial: false },
  resourceError: null,
  load: { connectedScreens: 1, retainedSessions: 4, detachedIdleSessions: 2, busySessions: 2, queuedSessions: 0, queuedResponses: 1, oldestWaitMs: 2345, maxActiveSessions: 20, maxBusySessions: 8 },
  api: { count: 20, p95Ms: 120 }, queueWait: { count: 0, p95Ms: null }, history: [],
};

describe("server load panel", () => {
  it("opens from the compact button, distinguishes empty samples and closes with focus restored", async () => {
    vi.mocked(readServerMetrics).mockResolvedValue(metrics);
    render(<AppStateProvider initialState={initialAppState}><ConcurrencyStatus /></AppStateProvider>);
    const user = userEvent.setup();
    const button = await screen.findByRole("button", { name: /동시 사용 현황/ });
    const tooltip = screen.getByRole("tooltip");
    expect(await within(tooltip).findByText("16.0 / 32.0 GB · 50.0%")).toBeTruthy();
    await user.click(button);
    const dialog = await screen.findByRole("dialog", { name: "서버 부하" });
    expect(readServerMetrics).toHaveBeenCalledWith(true);
    expect(within(dialog).getByText("12.3%")).toBeTruthy();
    expect(within(dialog).getByText("1.00 GB")).toBeTruthy();
    expect(within(dialog).getAllByText("표본 없음").length).toBeGreaterThan(0);
    expect(within(dialog).getByText("4 / 20")).toBeTruthy();
    expect(within(dialog).getByText("2.3초")).toBeTruthy();
    expect(within(dialog).queryByText(/429|Provider별/)).toBeNull();
    const close = within(dialog).getByRole("button", { name: "서버 부하 닫기" });
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement?.tagName).toBe("SUMMARY");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("shows collection failures rather than treating unavailable resources as zero", async () => {
    vi.mocked(readServerMetrics).mockResolvedValue({ ...metrics, resources: null, sampledAt: null, resourceError: "서버 자원 수집 불가" });
    render(<AppStateProvider initialState={initialAppState}><ConcurrencyStatus /></AppStateProvider>);
    await userEvent.click(await screen.findByRole("button", { name: /동시 사용 현황/ }));
    const dialog = await screen.findByRole("dialog", { name: "서버 부하" });
    expect(await within(dialog).findByText("서버 자원 수집 불가")).toBeTruthy();
    expect(within(dialog).queryByText("0.0%")).toBeNull();
    expect(within(dialog).queryByText("0.00 GB")).toBeNull();
  });
});
