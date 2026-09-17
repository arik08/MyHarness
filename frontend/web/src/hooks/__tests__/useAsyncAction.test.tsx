import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useAsyncAction } from "../useAsyncAction";

it("lets a new session act while the old request is pending and ignores its completion", async () => {
  let finishOld!: () => void;
  let finishNew!: () => void;
  const { result, rerender } = renderHook(({ session }) => useAsyncAction(session), { initialProps: { session: "a" } });
  act(() => { void result.current.run(() => new Promise<void>((resolve) => { finishOld = resolve; })); });
  rerender({ session: "b" });
  expect(result.current.pending).toBe(false);
  const next = vi.fn(() => new Promise<void>((resolve) => { finishNew = resolve; }));
  act(() => { void result.current.run(next); });
  expect(next).toHaveBeenCalledTimes(1);
  await act(async () => { finishOld(); });
  expect(result.current.pending).toBe(true);
  const duplicate = vi.fn(async () => {});
  act(() => { void result.current.run(duplicate); });
  expect(duplicate).not.toHaveBeenCalled();
  await act(async () => { finishNew(); });
  expect(result.current.pending).toBe(false);
});

it("reports pending before completion and blocks same-tick duplicates", async () => {
  let finish!: () => void;
  const action = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
  const { result } = renderHook(useAsyncAction);
  let work!: Promise<void>;
  act(() => { work = result.current.run(action); void result.current.run(action); });
  expect(result.current.pending).toBe(true);
  expect(action).toHaveBeenCalledTimes(1);
  await act(async () => { finish(); await work; });
  expect(result.current.pending).toBe(false);
});

it("releases the lock after failure and allows an unrelated new action", async () => {
  const { result } = renderHook(useAsyncAction);
  await act(async () => {
    await expect(result.current.run(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
  });
  expect(result.current.pending).toBe(false);
  const next = vi.fn(async () => {});
  await act(async () => { await result.current.run(next); });
  expect(next).toHaveBeenCalledTimes(1);
});
