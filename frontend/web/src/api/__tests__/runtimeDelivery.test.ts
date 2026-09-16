import { expect, it, vi } from "vitest";
import { postJson } from "../http";
import { sendBackendRequest, sendMessage } from "../messages";

vi.mock("../http", () => ({ postJson: vi.fn() }));

it("delivers model then effort before an immediately submitted turn, even after a failed request", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(postJson).mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; })).mockResolvedValue({ ok: true });
  const model = sendBackendRequest("ordered", "c", { type: "apply_select_command", command: "model", value: "future" });
  const effort = sendBackendRequest("ordered", "c", { type: "apply_select_command", command: "effort", value: "high" });
  const message = sendMessage({ sessionId: "ordered", clientId: "c", line: "hello" });
  expect(postJson).toHaveBeenCalledTimes(1);
  reject(new Error("offline"));
  await expect(model).rejects.toThrow("offline");
  await effort;
  await message;
  expect(vi.mocked(postJson).mock.calls.map(([path, body]) => [path, (body as any).payload?.command])).toEqual([
    ["/api/respond", "model"], ["/api/respond", "effort"], ["/api/message", undefined],
  ]);
});
