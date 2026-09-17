import { afterEach, expect, it, vi } from "vitest";
import { createClientId } from "../ids";

afterEach(() => vi.unstubAllGlobals());
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

it("uses native randomUUID when available", () => {
  const randomUUID = vi.fn(() => "native-id");
  vi.stubGlobal("crypto", { randomUUID });
  expect(createClientId()).toBe("native-id");
  expect(randomUUID).toHaveBeenCalledOnce();
});

it("generates UUIDs on LAN HTTP using getRandomValues", () => {
  const getRandomValues = vi.fn((bytes: Uint8Array) => bytes.fill(255));
  vi.stubGlobal("crypto", { getRandomValues });
  expect(createClientId()).toMatch(uuid);
  expect(getRandomValues).toHaveBeenCalledOnce();
});

it("keeps non-security correlation IDs available without the crypto object", () => {
  vi.stubGlobal("crypto", undefined);
  const ids = Array.from({ length: 1000 }, createClientId);
  expect(ids.every((id) => uuid.test(id))).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);
});
