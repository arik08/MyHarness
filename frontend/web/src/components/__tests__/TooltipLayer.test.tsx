import { fireEvent, render, screen } from "@testing-library/react";
import { act, useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipLayer } from "../TooltipLayer";

describe("TooltipLayer", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders data-tooltip text in a fixed overlay instead of inside the button", () => {
    vi.useFakeTimers();
    render(
      <div>
        <button
          type="button"
          data-tooltip="미리보기 확대"
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 46,
              height: 34,
              left: 894,
              right: 928,
              top: 12,
              width: 34,
              x: 894,
              y: 12,
              toJSON: () => ({}),
            });
          }}
        >
          expand
        </button>
        <TooltipLayer />
      </div>,
    );

    const button = screen.getByRole("button", { name: "expand" });
    fireEvent.pointerOver(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(260);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("미리보기 확대");
    expect(tooltip.parentElement).not.toBe(button);
    expect(tooltip.className).toBe("tooltip-layer");
    expect(tooltip.style.position).toBe("fixed");
  });

  it("places right-positioned tooltips beside the target", () => {
    vi.useFakeTimers();
    render(
      <div>
        <button
          type="button"
          data-tooltip="프로젝트 폴더 선택"
          data-tooltip-placement="right"
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 126,
              height: 52,
              left: 10,
              right: 314,
              top: 74,
              width: 304,
              x: 10,
              y: 74,
              toJSON: () => ({}),
            });
          }}
        >
          Default
        </button>
        <TooltipLayer />
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "Default" }));
    act(() => {
      vi.advanceTimersByTime(260);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("프로젝트 폴더 선택");
    expect(tooltip.style.left).toBe("322px");
    expect(tooltip.style.top).toBe("100px");
    expect(tooltip.style.transform).toBe("translate(0, -50%)");
  });

  it("places left-positioned tooltips beside the target", () => {
    vi.useFakeTimers();
    render(
      <div>
        <button
          type="button"
          data-tooltip="입력 옵션 닫기"
          data-tooltip-placement="left"
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 126,
              height: 30,
              left: 120,
              right: 150,
              top: 96,
              width: 30,
              x: 120,
              y: 96,
              toJSON: () => ({}),
            });
          }}
        >
          plus
        </button>
        <TooltipLayer />
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "plus" }));
    act(() => {
      vi.advanceTimersByTime(260);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("입력 옵션 닫기");
    expect(tooltip.style.top).toBe("111px");
    expect(tooltip.style.transform).toBe("translate(0, -50%)");
    expect(Number.parseFloat(tooltip.style.left)).toBeLessThan(120);
  });

  it("places top-positioned tooltips above the target", () => {
    vi.useFakeTimers();
    render(
      <div>
        <button
          type="button"
          data-tooltip="첨부 및 출력 옵션"
          data-tooltip-placement="top"
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 680,
              height: 32,
              left: 394,
              right: 426,
              top: 648,
              width: 32,
              x: 394,
              y: 648,
              toJSON: () => ({}),
            });
          }}
        >
          plus
        </button>
        <TooltipLayer />
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "plus" }));
    act(() => {
      vi.advanceTimersByTime(260);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.textContent).toBe("첨부 및 출력 옵션");
    expect(tooltip.style.left).toBe("410px");
    expect(tooltip.style.top).toBe("640px");
    expect(tooltip.style.transform).toBe("translate(-50%, -100%)");
  });

  it("keeps top-positioned tooltips above a declared boundary", () => {
    vi.useFakeTimers();
    render(
      <div
        data-tooltip-top-boundary="true"
        ref={(node) => {
          if (!node) {
            return;
          }
          node.getBoundingClientRect = () => ({
            bottom: 590,
            height: 80,
            left: 320,
            right: 760,
            top: 510,
            width: 440,
            x: 320,
            y: 510,
            toJSON: () => ({}),
          });
        }}
      >
        <button
          type="button"
          data-tooltip="산출물 생성 시 목표 분량입니다. 단위는 출력 토큰이며, 채팅 답변 길이에는 적용하지 않습니다."
          data-tooltip-placement="top"
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 552,
              height: 18,
              left: 520,
              right: 568,
              top: 534,
              width: 48,
              x: 520,
              y: 534,
              toJSON: () => ({}),
            });
          }}
        >
          출력한도
        </button>
        <TooltipLayer />
      </div>,
    );

    fireEvent.pointerOver(screen.getByRole("button", { name: "출력한도" }));
    act(() => {
      vi.advanceTimersByTime(260);
    });

    const tooltip = screen.getByRole("tooltip");
    expect(tooltip.style.left).toBe("544px");
    expect(tooltip.style.top).toBe("502px");
    expect(tooltip.style.transform).toBe("translate(-50%, -100%)");
  });

  it("shows focus tooltips immediately", () => {
    render(
      <div>
        <button type="button" data-tooltip="전체 설명">
          Help
        </button>
        <TooltipLayer />
      </div>,
    );

    fireEvent.focusIn(screen.getByRole("button", { name: "Help" }));

    expect(screen.getByRole("tooltip").textContent).toBe("전체 설명");
  });

  it("refreshes visible tooltip text when the hovered target data-tooltip changes", async () => {
    vi.useFakeTimers();

    function DynamicTooltipButton() {
      const [theme, setTheme] = useState("Claude");
      return (
        <button
          type="button"
          data-tooltip={`테마: ${theme}`}
          onClick={() => setTheme("POSCO")}
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 46,
              height: 34,
              left: 40,
              right: 74,
              top: 12,
              width: 34,
              x: 40,
              y: 12,
              toJSON: () => ({}),
            });
          }}
        >
          theme
        </button>
      );
    }

    render(
      <div>
        <DynamicTooltipButton />
        <TooltipLayer />
      </div>,
    );

    const button = screen.getByRole("button", { name: "theme" });
    fireEvent.pointerOver(button);
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(screen.getByRole("tooltip").textContent).toBe("테마: Claude");

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("tooltip").textContent).toBe("테마: POSCO");
  });

  it("keeps a hovered tooltip visible when a click briefly moves focus away", async () => {
    vi.useFakeTimers();

    function CopyButton() {
      const [copied, setCopied] = useState(false);
      return (
        <button
          type="button"
          data-tooltip={copied ? "공유 링크 복사됨" : "공유 링크 복사"}
          onClick={() => setCopied(true)}
          ref={(node) => {
            if (!node) {
              return;
            }
            node.getBoundingClientRect = () => ({
              bottom: 46,
              height: 34,
              left: 40,
              right: 74,
              top: 12,
              width: 34,
              x: 40,
              y: 12,
              toJSON: () => ({}),
            });
          }}
        >
          share
        </button>
      );
    }

    render(
      <div>
        <CopyButton />
        <textarea aria-label="clipboard scratch" />
        <TooltipLayer />
      </div>,
    );

    const button = screen.getByRole("button", { name: "share" });
    const scratch = screen.getByRole("textbox", { name: "clipboard scratch" });

    fireEvent.pointerOver(button);
    act(() => {
      vi.advanceTimersByTime(260);
    });
    expect(screen.getByRole("tooltip").textContent).toBe("공유 링크 복사");

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.focusOut(button, { relatedTarget: scratch });

    expect(screen.getByRole("tooltip").textContent).toBe("공유 링크 복사됨");
  });

  it("shows a changed hovered tooltip immediately without waiting for the hover delay", async () => {
    vi.useFakeTimers();

    function CopyButton() {
      const [copied, setCopied] = useState(false);
      return (
        <button type="button" data-tooltip={copied ? "공유 링크 복사됨" : "공유 링크 복사"} onClick={() => setCopied(true)}>
          share
        </button>
      );
    }

    render(
      <div>
        <CopyButton />
        <TooltipLayer />
      </div>,
    );

    const button = screen.getByRole("button", { name: "share" });
    fireEvent.pointerOver(button);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.pointerDown(button);
    expect(screen.getByRole("tooltip").textContent).toBe("공유 링크 복사");

    fireEvent.click(button);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByRole("tooltip").textContent).toBe("공유 링크 복사됨");
  });

});
