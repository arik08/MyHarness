import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../App";

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

  it("reports a web visit when the React app mounts", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith("/api/visit", expect.objectContaining({ method: "POST" }));
    });
  });
});
