import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPngToClipboard } from "../clipboard";

describe("copyPngToClipboard", () => {
  const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");

  afterEach(() => {
    if (originalSecureContext) {
      Object.defineProperty(window, "isSecureContext", originalSecureContext);
    } else {
      Reflect.deleteProperty(window, "isSecureContext");
    }
    vi.restoreAllMocks();
  });

  it("sends the PNG to the local Windows clipboard bridge on HTTP", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const png = new Blob(["png"], { type: "image/png" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ ok: true }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));

    await copyPngToClipboard(Promise.resolve(png));

    expect(fetchMock).toHaveBeenCalledWith("/api/clipboard/image", {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: png,
    });
  });

  it("reports the local clipboard bridge error instead of claiming success", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify({ error: "같은 Windows PC에서만 사용할 수 있습니다." }),
      { status: 403, headers: { "content-type": "application/json" } },
    ));

    await expect(copyPngToClipboard(Promise.resolve(new Blob(["png"], { type: "image/png" }))))
      .rejects.toThrow("같은 Windows PC에서만 사용할 수 있습니다.");
  });
});
