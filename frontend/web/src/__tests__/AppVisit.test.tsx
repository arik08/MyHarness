import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";
import { useBackendSession } from "../hooks/useBackendSession";

vi.mock("../components/AppShell", () => ({
  AppShell: () => <main>app shell</main>,
}));

vi.mock("../hooks/useBackendSession", () => ({
  useBackendSession: vi.fn(),
}));

vi.mock("../hooks/useWorkspaceData", () => ({
  useWorkspaceData: vi.fn(),
}));

describe("App visit tracking", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the app locked until the server accepts the password", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticated: false }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "invalid password" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ ok: true }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await screen.findByLabelText("비밀번호");
    expect(screen.queryByText("app shell")).toBeNull();
    expect(useBackendSession).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "9999" } });
    fireEvent.click(screen.getByRole("button", { name: "계속" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("비밀번호가 올바르지 않습니다."));
    expect(screen.queryByText("app shell")).toBeNull();

    fireEvent.change(screen.getByLabelText("비밀번호"), { target: { value: "1212" } });
    fireEvent.click(screen.getByRole("button", { name: "계속" }));
    await screen.findByText("app shell");
    expect(useBackendSession).toHaveBeenCalled();
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/auth/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ password: "9999" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/auth/login", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ password: "1212" }),
    }));
  });

  it("reports a web visit when the React app mounts", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ authenticated: true }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({ ok: true }),
        text: async () => "",
      });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/visit", expect.objectContaining({ method: "POST" }));
    });
  });
});
