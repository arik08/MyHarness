import { afterEach, describe, expect, it, vi } from "vitest";
import { postJson } from "../http";

describe("http admin mode headers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function mockJsonResponse() {
    return vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  }

  it("adds the admin mode header to write requests when admin mode is persisted", async () => {
    localStorage.setItem("myharness:adminMode", "1");
    const fetchMock = mockJsonResponse();

    await postJson("/api/settings/shell", { shell: "auto" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      "Content-Type": "application/json",
      "X-MyHarness-Admin-Mode": "1",
    });
  });

  it("omits the admin mode header from ordinary write requests", async () => {
    const fetchMock = mockJsonResponse();

    await postJson("/api/settings/shell", { shell: "auto" });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(init.headers).not.toHaveProperty("X-MyHarness-Admin-Mode");
  });
});
