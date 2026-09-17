import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { QuestionRound } from "../QuestionRound";
import { sendBackendRequest } from "../../api/messages";

vi.mock("../../api/messages", () => ({ sendBackendRequest: vi.fn().mockResolvedValue({}) }));
vi.mock("../../state/app-state", () => ({ useAppState: () => ({ state: { sessionId: "test", clientId: "client" } }) }));
const question = { id: "new", question: "필요한 결과물은?", choices: [
  { value: "a,b", label: "보고서" }, { value: "c", label: "대시보드" },
] };
const payload = { request_id: "round", questions: [question] };
beforeEach(() => { sessionStorage.clear(); vi.clearAllMocks(); });
afterEach(cleanup);
const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

it("defaults to multiple, toggles options and preserves exact values on submit", () => {
  render(<QuestionRound payload={payload} />);
  click("보고서"); click("대시보드"); click("보고서");
  expect(screen.getByRole("button", { name: "보고서" }).getAttribute("aria-pressed")).toBe("false");
  click("보고서"); click("답변 보내기");
  const response = vi.mocked(sendBackendRequest).mock.calls[0][2];
  expect(JSON.parse(String(response.answer))[0].answer).toEqual(["c", "a,b"]);
});

it("replaces the selection only when the model explicitly chooses single select", () => {
  render(<QuestionRound payload={{ ...payload, questions: [{ ...question, multi_select: false }] }} />);
  click("보고서"); click("대시보드");
  expect(screen.getByRole("button", { name: "보고서" }).getAttribute("aria-pressed")).toBe("false");
  click("답변 보내기");
  expect(JSON.parse(String(vi.mocked(sendBackendRequest).mock.calls[0][2].answer))[0].answer).toBe("c");
});

it("restores multiple selections and lets free text replace them", () => {
  const view = render(<QuestionRound payload={payload} />);
  click("보고서"); click("대시보드"); view.unmount();
  render(<QuestionRound payload={payload} />);
  expect(screen.getByRole("button", { name: "보고서" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "대시보드" }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "다른 결과물" } });
  click("답변 보내기");
  expect(JSON.parse(String(vi.mocked(sendBackendRequest).mock.calls[0][2].answer))[0]).toMatchObject({ kind: "text", answer: "다른 결과물" });
});

it("does not restore a multiple draft into a single-select question", () => {
  sessionStorage.setItem("myharness:question:test:round", JSON.stringify({ new: { kind: "choice", answer: ["a,b", "c"] } }));
  render(<QuestionRound payload={{ ...payload, questions: [{ ...question, multi_select: false }] }} />);
  expect((screen.getByRole("button", { name: "답변 보내기" }) as HTMLButtonElement).disabled).toBe(true);
});

it("updates free text immediately, clears stale text on choice selection and blocks empty submission", () => {
  render(<QuestionRound payload={payload} />);
  const input = screen.getByRole("textbox") as HTMLInputElement;
  const send = screen.getByRole("button", { name: "답변 보내기" }) as HTMLButtonElement;
  fireEvent.change(input, { target: { value: "직접 작성" } });
  expect(send.disabled).toBe(false);
  fireEvent.keyDown(input, { key: "Enter" });
  expect(sendBackendRequest).not.toHaveBeenCalled();
  click("보고서");
  expect(input.value).toBe("");
  fireEvent.change(input, { target: { value: "새 답변" } });
  expect(screen.getByRole("button", { name: "보고서" }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.change(input, { target: { value: "   " } });
  expect(send.disabled).toBe(true);
  fireEvent.change(input, { target: { value: "" } });
  expect(send.disabled).toBe(true);
});
