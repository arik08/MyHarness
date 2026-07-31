import { afterEach, describe, expect, it, vi } from "vitest";
import { copyPngToClipboard } from "../clipboard";

describe("copyPngToClipboard", () => {
  const originalSecureContext = Object.getOwnPropertyDescriptor(window, "isSecureContext");
  const originalCreateObjectUrl = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
  const originalRevokeObjectUrl = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");

  afterEach(() => {
    if (originalSecureContext) {
      Object.defineProperty(window, "isSecureContext", originalSecureContext);
    } else {
      Reflect.deleteProperty(window, "isSecureContext");
    }
    if (originalCreateObjectUrl) Object.defineProperty(URL, "createObjectURL", originalCreateObjectUrl);
    else Reflect.deleteProperty(URL, "createObjectURL");
    if (originalRevokeObjectUrl) Object.defineProperty(URL, "revokeObjectURL", originalRevokeObjectUrl);
    else Reflect.deleteProperty(URL, "revokeObjectURL");
    vi.restoreAllMocks();
  });

  it("downloads the PNG on HTTP instead of writing to the server clipboard", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    const png = new Blob(["png"], { type: "image/png" });
    const createObjectUrl = vi.fn(() => "blob:report");
    const revokeObjectUrl = vi.fn(() => undefined);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectUrl });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectUrl });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

    await expect(copyPngToClipboard(Promise.resolve(png), "report.png")).resolves.toBe("downloaded");

    expect(createObjectUrl).toHaveBeenCalledWith(png);
    expect(click).toHaveBeenCalledOnce();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:report");
  });

  it("copies the PNG directly in a secure context", async () => {
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const originalClipboardItem = globalThis.ClipboardItem;
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: true,
    });
    const write = vi.fn(async () => undefined);
    class FakeClipboardItem {
      constructor(readonly values: Record<string, Promise<Blob>>) {}
    }
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write } });
    Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: FakeClipboardItem });

    try {
      await expect(copyPngToClipboard(Promise.resolve(new Blob(["png"], { type: "image/png" })))).resolves.toBe("copied");
      expect(write).toHaveBeenCalledOnce();
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
      if (originalClipboardItem) Object.defineProperty(globalThis, "ClipboardItem", { configurable: true, value: originalClipboardItem });
      else Reflect.deleteProperty(globalThis, "ClipboardItem");
    }
  });
});
