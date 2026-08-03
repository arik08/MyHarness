import { afterEach, describe, expect, it, vi } from "vitest";
import { readLocalStorage, writeLocalStorage } from "../storage";

describe("safe local storage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back when storage reads are blocked", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(readLocalStorage("key", "fallback")).toBe("fallback");
  });

  it("ignores blocked storage writes", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });

    expect(() => writeLocalStorage("key", "value")).not.toThrow();
  });
});
