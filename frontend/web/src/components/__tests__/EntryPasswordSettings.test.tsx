import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsModal } from "../SettingsModal";
import { AppStateProvider } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { changeEntryPassword } from "../../api/settings";

vi.mock("../../api/settings", async (original) => ({ ...await original<typeof import("../../api/settings")>(), changeEntryPassword: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); localStorage.clear(); });
function setup(adminMode = true) {
  render(<AppStateProvider initialState={{ ...initialAppState, adminMode }}><SettingsModal onClose={() => undefined} /></AppStateProvider>);
}
function fill(confirmation = "next") {
  fireEvent.change(screen.getByLabelText("현재 기본 비밀번호"), { target: { value: "old" } });
  fireEvent.change(screen.getByLabelText("새 비밀번호"), { target: { value: "next" } });
  fireEvent.change(screen.getByLabelText("새 비밀번호 확인"), { target: { value: confirmation } });
}
it("hides entry password shortcut outside admin mode", () => {
  setup(false);
  expect(screen.queryByRole("button", { name: "접속 비밀번호 변경" })).toBeNull();
});
it("places shortcut before admin, validates confirmation and gives immediate save feedback", async () => {
  setup();
  const shortcut = screen.getByRole("button", { name: "접속 비밀번호 변경" });
  expect(shortcut.nextElementSibling).toBe(screen.getByRole("button", { name: "Admin mode" }));
  fireEvent.click(shortcut);
  fill("wrong");
  fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));
  expect(screen.getByRole("alert").textContent).toContain("일치하지");
  expect(changeEntryPassword).not.toHaveBeenCalled();
  fill();
  let resolve!: (value: { ok: boolean }) => void;
  vi.mocked(changeEntryPassword).mockReturnValue(new Promise((done) => { resolve = done; }));
  fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" }));
  expect(screen.getByRole("button", { name: "변경 중…" }).hasAttribute("disabled")).toBe(true);
  fireEvent.submit(screen.getByLabelText("새 비밀번호").closest("form")!);
  expect(changeEntryPassword).toHaveBeenCalledTimes(1);
  await act(async () => resolve({ ok: true }));
  expect(screen.getByRole("status").textContent).toContain("변경했습니다");
  expect((screen.getByLabelText("현재 기본 비밀번호") as HTMLInputElement).value).toBe("");
});
it("keeps input on failure and allows retry", async () => {
  setup(); fireEvent.click(screen.getByRole("button", { name: "접속 비밀번호 변경" })); fill();
  vi.mocked(changeEntryPassword).mockRejectedValueOnce(new Error("저장 실패"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" })));
  expect(screen.getByRole("alert").textContent).toBe("저장 실패");
  expect((screen.getByLabelText("새 비밀번호") as HTMLInputElement).value).toBe("next");
  expect(screen.getByRole("button", { name: "비밀번호 변경" }).hasAttribute("disabled")).toBe(false);
});
it("selects Guest independently and clears fields when changing kinds", async () => {
  setup(); fireEvent.click(screen.getByRole("button", { name: "접속 비밀번호 변경" })); fill();
  expect(screen.getByRole("button", { name: "기본 비밀번호" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Guest 비밀번호" }));
  expect(screen.getByRole("button", { name: "Guest 비밀번호" }).getAttribute("aria-pressed")).toBe("true");
  expect((screen.getByLabelText("새 비밀번호") as HTMLInputElement).value).toBe("");
  fill(); vi.mocked(changeEntryPassword).mockResolvedValue({ ok: true });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "비밀번호 변경" })));
  expect(changeEntryPassword).toHaveBeenCalledWith("old", "next", "next", "guest");
  expect(screen.getByRole("status").textContent).toContain("Guest 비밀번호");
});
