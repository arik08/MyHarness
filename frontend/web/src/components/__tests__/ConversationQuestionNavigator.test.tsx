import { fireEvent, render, screen, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationQuestionNavigator } from "../ConversationQuestionNavigator";
import { TooltipLayer } from "../TooltipLayer";
import type { ChatMessage } from "../../types/ui";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const messages: ChatMessage[] = [
  { id: "u1", role: "user", text: "**첫 질문**" },
  { id: "log", role: "log", text: "도구 실행" },
  { id: "a1", role: "assistant", text: "[첫 답변](https://example.com)" },
  { id: "u2", role: "user", text: "둘째 질문" },
  { id: "u3", role: "user", text: "셋째 질문" },
  { id: "a3", role: "assistant", text: "셋째 답변" },
];

describe("ConversationQuestionNavigator", () => {
  it("previews question and answer, without borrowing the next question's answer", () => {
    render(<><ConversationQuestionNavigator messages={messages} scrollContainerRef={{ current: null }} onNavigateStart={() => {}} /><TooltipLayer /></>);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    const first = screen.getByRole("button", { name: "질문 1로 이동: 첫 질문" });
    fireEvent.pointerOver(first);
    expect(screen.getByRole("tooltip").textContent).toBe("첫 질문첫 답변");
    expect(first.hasAttribute("title")).toBe(false);
    fireEvent.focus(screen.getByRole("button", { name: "질문 2로 이동: 둘째 질문" }));
    expect(screen.getByRole("tooltip").textContent).toBe("둘째 질문아직 답변이 없습니다.");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("tooltip")).toBeNull();
  });

  it("aligns the selected question inside its own scroller and stops automatic following", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    const container = document.createElement("section");
    const target = document.createElement("article");
    target.dataset.messageId = "u1";
    container.append(target);
    Object.defineProperties(container, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    container.scrollTop = 800;
    vi.spyOn(container, "getBoundingClientRect").mockReturnValue({ top: 60 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: -440 } as DOMRect);
    const stopFollow = vi.fn();
    render(<ConversationQuestionNavigator messages={messages} scrollContainerRef={{ current: container }} onNavigateStart={stopFollow} />);
    fireEvent.click(screen.getByRole("button", { name: "질문 1로 이동: 첫 질문" }));
    expect(stopFollow).toHaveBeenCalledOnce();
    expect(container.scrollTop).toBe(276);
  });

  it("does not render a rail for an empty conversation", () => {
    render(<ConversationQuestionNavigator messages={[]} scrollContainerRef={{ current: null }} onNavigateStart={() => {}} />);
    expect(screen.queryByRole("navigation")).toBeNull();
  });
});
