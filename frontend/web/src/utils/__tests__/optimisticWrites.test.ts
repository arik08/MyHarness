import { expect, it, vi } from "vitest";
import { createOptimisticWrites } from "../optimisticWrites";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("shows new values before saving and serializes rapid changes without flashing old responses", async () => {
  const write = createOptimisticWrites();
  const first = deferred<string>();
  const last = deferred<string>();
  const persist = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
  const apply = vi.fn();
  const options = { key: "unregistered-field", previous: "old", apply, persist, onError: vi.fn() };
  const running = write({ ...options, value: "first" });
  expect(apply).toHaveBeenLastCalledWith("first");
  await write({ ...options, value: "second" });
  await write({ ...options, value: "latest" });
  expect(persist).toHaveBeenCalledTimes(1);
  first.resolve("first");
  await Promise.resolve();
  expect(apply).toHaveBeenLastCalledWith("latest");
  expect(persist).toHaveBeenLastCalledWith("latest");
  last.resolve("latest");
  await running;
});

it("restores the last saved value on failure without blocking another field", async () => {
  const write = createOptimisticWrites();
  const failure = deferred<boolean>();
  const apply = vi.fn();
  const onError = vi.fn();
  const pending = write({ key: "one", previous: false, value: true, apply, persist: () => failure.promise, onError });
  const other = vi.fn();
  await write({ key: "two", previous: 0, value: 2, apply: other, persist: async (value) => value, onError });
  expect(other).toHaveBeenLastCalledWith(2);
  failure.reject(new Error("offline"));
  await pending;
  expect(apply).toHaveBeenLastCalledWith(false);
  expect(onError).toHaveBeenCalledTimes(1);
});
