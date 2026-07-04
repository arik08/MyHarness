import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../Composer";
import { MessageList } from "../MessageList";
import { ModalHost } from "../ModalHost";
import { AppStateProvider, useAppState } from "../../state/app-state";
import { initialAppState } from "../../state/reducer";
import { cancelMessage, sendBackendRequest, sendMessage, uploadClientAttachments } from "../../api/messages";
import { startSession } from "../../api/session";

vi.mock("../../api/messages", () => ({
  cancelMessage: vi.fn().mockResolvedValue({ ok: true }),
  sendBackendRequest: vi.fn().mockResolvedValue({ ok: true }),
  sendMessage: vi.fn().mockResolvedValue({ ok: true }),
  uploadClientAttachments: vi.fn().mockResolvedValue({ attachments: [] }),
}));

vi.mock("../../api/session", () => ({
  startSession: vi.fn().mockResolvedValue({ sessionId: "session-new" }),
}));

function readStylesheet() {
  return readFileSync(resolve(__dirname, "../../../styles.css"), "utf8").replace(/\r\n/g, "\n");
}

describe("Composer", () => {
  beforeEach(() => {
    vi.mocked(cancelMessage).mockClear();
    vi.mocked(sendMessage).mockClear();
    vi.mocked(sendBackendRequest).mockClear();
    vi.mocked(uploadClientAttachments).mockClear();
    vi.mocked(uploadClientAttachments).mockResolvedValue({ attachments: [] });
    vi.mocked(startSession).mockClear();
    vi.mocked(startSession).mockResolvedValue({ sessionId: "session-new" });
    document.documentElement.style.removeProperty("--composer-stack-height");
  });

  it("keeps send disabled until a backend session exists", async () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByRole("textbox");
    const send = document.querySelector<HTMLButtonElement>("#sendButton");

    expect(send?.disabled).toBe(true);
    await userEvent.type(input, "hello");
    expect(send?.disabled).toBe(true);
  });

  it("uses POSCO Blue for the default theme send button", () => {
    const stylesheet = readStylesheet();

    expect(stylesheet).toContain("--send-button-bg: #0072bc;");
    expect(stylesheet).toContain("--send-button-ink: #ffffff;");
  });

  it("does not expose an image file attachment button", () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.queryByRole("button", { name: "이미지 첨부" })).toBeNull();
  });

  it("opens the attached composer panel without native title tooltips", async () => {
    const user = userEvent.setup();
    const stylesheet = readStylesheet();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <Composer />
      </AppStateProvider>,
    );

    const toggle = screen.getByRole("button", { name: "입력 옵션 열기" });
    expect(toggle.getAttribute("title")).toBeNull();
    expect(toggle.getAttribute("data-tooltip")).toBeNull();
    expect(toggle.getAttribute("data-tooltip-placement")).toBeNull();

    await user.click(toggle);

    expect(screen.getByLabelText("입력 옵션").classList.contains("hidden")).toBe(false);
    expect(screen.getByLabelText("입력 옵션").getAttribute("data-tooltip-top-boundary")).toBe("true");
    expect(document.querySelector(".composer-box")?.classList.contains("with-panel")).toBe(true);
    const attachButton = screen.getByRole("button", { name: "파일첨부" });
    expect(attachButton.getAttribute("title")).toBeNull();
    expect(attachButton.getAttribute("data-tooltip")).toBe("파일첨부");
    expect(attachButton.getAttribute("data-tooltip-placement")).toBe("top");
    expect(attachButton.textContent).toBe("");
    const controlLabels = Array.from(document.querySelectorAll<HTMLElement>(".composer-control-label"));
    expect(controlLabels.map((node) => node.textContent)).toEqual(["출력", "모드", "출력한도"]);
    expect(controlLabels.map((node) => node.getAttribute("data-tooltip-placement"))).toEqual(["top", "top", "top"]);
    expect(controlLabels.map((node) => node.getAttribute("data-tooltip"))).toEqual([
      "답변을 채팅에 표시할지 파일로 만들지 정합니다. 자동은 요청에 맞춰 판단합니다.",
      "파일을 만들 때 새로 생성할지 기존 파일을 수정할지 정합니다.",
      "파일 생성 시 목표 분량입니다. 단위는 출력 토큰이며, 채팅 답변 길이에는 적용하지 않습니다.",
    ]);
    expect(Array.from(screen.getByLabelText("파일 작업").querySelectorAll("button")).every((button) => !button.disabled)).toBe(true);
    expect(screen.getByLabelText("출력 위치").querySelector("button")?.textContent).toBe("자동");
    expect(screen.getByLabelText("출력 길이").querySelector("button")?.textContent).toBe("자동");
    expect(screen.queryByRole("button", { name: "8k" })).toBeNull();
    expect(screen.getByRole("button", { name: "16k" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "~20k" })).toBeNull();
    expect(screen.queryByRole("button", { name: "초장문" })).toBeNull();
    expect(screen.queryByRole("button", { name: "직접" })).toBeNull();
    expect(screen.getByRole("button", { name: "~24k" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "~32k" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "~40k" })).toBeTruthy();
    expect(stylesheet).toContain(".composer-expand-button.active {\n  color: var(--muted);");
    expect(stylesheet).toContain("stroke-width: 2.45;");
    expect(stylesheet).toContain(".composer-expand-button.active svg {\n  transform: translateY(-1px);");
    expect(stylesheet).not.toContain(".composer-expand-button.active svg {\n  transform: rotate(45deg);");
    expect(stylesheet).toContain("border-radius: 14px 14px 0 0;");
    expect(stylesheet).not.toContain("0 -9px 26px color-mix(in srgb, var(--inverse) 7%, transparent)");
  });

  it("keeps the send payload unchanged when the panel is opened but not edited", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "기본 동작 확인");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.not.objectContaining({
      composeOptions: expect.anything(),
      attachmentRefs: expect.anything(),
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "기본 동작 확인",
      attachments: [],
    }));
  });

  it("resets expanded panel options when the panel is closed", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "파일" }));
    await user.click(screen.getByRole("button", { name: "수정" }));
    await user.click(screen.getByRole("button", { name: "16k" }));
    await user.click(screen.getByRole("button", { name: "입력 옵션 닫기" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "접은 뒤에는 자동으로 보내줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.not.objectContaining({
      composeOptions: expect.anything(),
    }));
  });

  it("serializes artifact edit compose options with the active artifact path", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          activeArtifact: { path: "outputs/current-report.html", name: "current-report.html", kind: "html" },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "파일" }));
    await user.click(screen.getByRole("button", { name: "수정" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "현재 보고서 다듬어줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        output_surface: "artifact",
        artifact_action: "edit",
        active_artifact_path: "outputs/current-report.html",
      },
    }));
  });

  it("passes the active artifact path for plain chat requests from the preview context", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          activeArtifact: { path: "outputs/current-report.html", name: "current-report.html", kind: "html" },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "이 보고서 제목만 더 짧게 바꿔줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        active_artifact_path: "outputs/current-report.html",
      },
    }));
  });

  it("keeps output auto while passing artifact output amount preferences", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "~40k" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "대보고서 작성");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        length_preset: "extra_long",
        target_output_tokens: 40000,
      },
    }));
  });

  it("keeps output auto while passing artifact mode preferences", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "생성" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "필요하면 새 산출물로 만들어줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        artifact_action: "create",
      },
    }));
  });

  it("serializes extra-long output amount with explicit artifact output", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "파일" }));
    await user.click(screen.getByRole("button", { name: "~40k" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "대보고서 작성");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        output_surface: "artifact",
        artifact_action: "auto",
        length_preset: "extra_long",
        target_output_tokens: 40000,
      },
    }));
  });

  it("serializes 16k output amount with explicit artifact output", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "파일" }));
    await user.click(screen.getByRole("button", { name: "16k" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "16k 정도로 답변해줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        output_surface: "artifact",
        artifact_action: "auto",
        length_preset: "extended",
        target_output_tokens: 16000,
      },
    }));
  });

  it("keeps chat output from changing target token length", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    await user.click(screen.getByRole("button", { name: "16k" }));
    await user.click(screen.getByRole("button", { name: "생성" }));
    await user.click(screen.getByRole("button", { name: "채팅" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "채팅창에만 답해줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: {
        output_surface: "chat",
      },
    }));
  });

  it("uploads client files, renders chips, removes them, and sends refs", async () => {
    const user = userEvent.setup();
    vi.mocked(uploadClientAttachments).mockResolvedValueOnce({
      attachments: [
        {
          id: "upload-1",
          name: "client-notes.pdf",
          path: ".myharness/client-uploads/client/batch/client-notes.pdf",
          size: 2048,
          media_type: "application/pdf",
        },
      ],
    });
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "입력 옵션 열기" }));
    const fileInput = document.querySelector<HTMLInputElement>(".composer-file-input");
    expect(fileInput).toBeTruthy();

    await user.upload(fileInput!, new File(["pdf"], "client-notes.pdf", { type: "application/pdf" }));

    expect(uploadClientAttachments).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      files: expect.arrayContaining([expect.objectContaining({ name: "client-notes.pdf" })]),
    }));
    expect(screen.getByText("client-notes.pdf")).toBeTruthy();
    expect(screen.getByText("2.0 KB")).toBeTruthy();
    const stylesheet = readStylesheet();
    expect(stylesheet).toContain(".composer-panel-controls {\n  display: flex;\n  align-items: center;\n  justify-content: space-between;\n  gap: 12px;\n  width: 100%;\n  min-width: 0;\n  margin-block: -2px;\n  padding-block: 2px;\n  overflow-x: auto;");
    expect(stylesheet).toContain(".composer-attachment-row {\n  display: flex;\n  align-items: center;\n  gap: 6px;\n  width: min(780px, calc(100% - 24px));\n  min-width: 0;\n  margin: 0 auto 7px;");
    expect(stylesheet).toContain(".pasted-text-tray {\n  display: flex;\n  gap: 6px;\n  width: min(780px, calc(100% - 24px));");
    expect(stylesheet).toContain(".pasted-text-tray,\n  .composer-attachment-row {\n    width: min(100% - 48px, 736px);\n  }");
    expect(stylesheet).toContain(".client-attachment-type {\n  display: grid;\n  place-items: center;\n  min-width: 24px;\n  padding: 0 4px;");
    expect(stylesheet).not.toContain(".composer-attach-group:has(.client-attachment-tray)");

    await user.click(screen.getByRole("button", { name: "client-notes.pdf 삭제" }));
    expect(screen.queryByText("client-notes.pdf")).toBeNull();

    vi.mocked(uploadClientAttachments).mockResolvedValueOnce({
      attachments: [
        {
          id: "upload-2",
          name: "client-notes.pdf",
          path: ".myharness/client-uploads/client/batch/client-notes.pdf",
          size: 2048,
          media_type: "application/pdf",
        },
      ],
    });
    await user.upload(fileInput!, new File(["pdf"], "client-notes.pdf", { type: "application/pdf" }));

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "이 파일 요약해줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(document.querySelector("article.message.user")?.textContent).toContain("[client-notes.pdf]");
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachmentRefs: [
        expect.objectContaining({
          name: "client-notes.pdf",
          path: ".myharness/client-uploads/client/batch/client-notes.pdf",
        }),
      ],
    }));
  });

  it("fills the composer from a starter prompt without native title tooltips", async () => {
    const user = userEvent.setup();
    const expectedPrompt = "[포스코 관련 국내외 언론기사 동향]에 대해 최근 3개월의 자료를 조사하고, 보고서로 작성해줘";

    render(
      <AppStateProvider>
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    const starterButtons = document.querySelectorAll<HTMLButtonElement>(".starter-prompt-button");
    expect(starterButtons).toHaveLength(9);

    const firstButton = screen.getByRole("button", { name: /보고서 작성\s+주제 조사 보고서/ });
    expect(firstButton.getAttribute("title")).toBeNull();
    expect(firstButton.getAttribute("data-tooltip")).toBe(expectedPrompt);

    await user.click(firstButton);

    const input = screen.getByPlaceholderText("메시지를 입력하세요...") as HTMLTextAreaElement;
    await waitFor(() => expect(input.value).toBe(expectedPrompt));
    expect(document.activeElement).toBe(input);
  });

  it("renders long pasted text with the legacy tray chip", () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) => type === "text/plain"
          ? Array.from({ length: 21 }, (_, index) => `line ${index + 1}`).join("\n")
          : "",
      },
    });

    const chip = document.querySelector(".pasted-text-chip");
    expect(chip).toBeTruthy();
    expect(chip?.textContent).toContain("[붙여넣은 텍스트 #1 +21줄]");
    expect(screen.getByRole("button", { name: "붙여넣은 텍스트 삭제" })).toBeTruthy();
    expect(document.querySelector(".react-pasted-chip")).toBeNull();
  });

  it("renders pasted images with the legacy thumbnail chip and preview modal", async () => {
    const stylesheet = readStylesheet();
    const file = new File(["image"], "pasted-image.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };
    const readerSpy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function readAsDataURLMock(this: FileReader) {
      Object.defineProperty(this, "result", {
        configurable: true,
        value: "data:image/png;base64,aW1hZ2U=",
      });
      this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    });

    render(
      <AppStateProvider>
        <Composer />
        <ModalHost />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    fireEvent.paste(input, {
      clipboardData: {
        items: [item],
        getData: () => "",
      },
    });

    const image = await screen.findByRole("button", { name: "pasted-image.png" });
    expect(document.querySelector(".attachment-chip")).toBeTruthy();
    expect(document.querySelector(".react-attachment-chip")).toBeNull();
    expect(stylesheet).toContain(".composer-box:has(.attachment-tray:not(.hidden)) {\n  align-items: end;\n  min-height: 84px;\n  padding: 8px 5px 6px 14px;\n  border-radius: 22px;");
    expect(stylesheet).not.toContain(".composer-box:has(.attachment-tray:not(.hidden)) {\n  align-items: end;\n  min-height: 84px;\n  padding: 8px 5px 6px 14px;\n  border-radius: 28px;");

    await userEvent.click(image);
    expect(await screen.findByRole("dialog", { name: "pasted-image.png" })).toBeTruthy();
    readerSpy.mockRestore();
  });

  it("shows the pasted image filename in the sent user message", async () => {
    const user = userEvent.setup();
    const file = new File(["image"], "quarter-plan.png", { type: "image/png" });
    const item = { kind: "file", type: "image/png", getAsFile: () => file };
    const readerSpy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function readAsDataURLMock(this: FileReader) {
      Object.defineProperty(this, "result", {
        configurable: true,
        value: "data:image/png;base64,aW1hZ2U=",
      });
      this.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
    });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    fireEvent.paste(input, {
      clipboardData: {
        items: [item],
        getData: () => "",
      },
    });
    await screen.findByRole("button", { name: "quarter-plan.png" });
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(screen.getByText("[quarter-plan.png]")).toBeTruthy();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      attachments: [expect.objectContaining({ name: "quarter-plan.png" })],
      line: "",
    }));
    readerSpy.mockRestore();
  });

  it("moves the active command suggestion with arrow keys and applies it", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          commands: [
            { name: "help", description: "도움말" },
            { name: "plan", description: "계획 모드" },
            { name: "review", description: "리뷰" },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "/");

    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/help");

    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/plan");

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/help");

    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/review");

    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "/review");
  });

  it("submits an exact slash command with Enter while suggestions are open", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          commands: [
            { name: "show-help", description: "도움말 보기" },
            { name: "help", description: "도움말" },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "/help");

    expect(screen.getByRole("option", { selected: true }).textContent).toContain("/show-help");

    await user.keyboard("{Enter}");

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "/help",
      suppressUserTranscript: true,
    }));
  });

  it("opens help immediately without appending a chat message and refreshes the active session quietly", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          commands: [{ name: "help", description: "도움말" }],
          skills: [{ name: "frontend-design", description: "UI 작업", source: "skill", enabled: true }],
          mcpServers: [{ name: "docs", state: "connected", detail: "문서 검색", transport: "stdio" }],
          plugins: [{ name: "Browser", description: "브라우저", enabled: true }],
        }}
      >
        <MessageList />
        <ModalHost />
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "/help");
    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "명령어" })).toBeTruthy();
    expect(screen.getByText("스킬")).toBeTruthy();
    expect(screen.getByText("MCP")).toBeTruthy();
    expect(screen.getByText("플러그인")).toBeTruthy();
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith({
      sessionId: "session-1",
      clientId: "client-1",
      line: "/help",
      attachments: [],
      suppressUserTranscript: true,
    }));
    expect(document.querySelectorAll(".messages > article.message")).toHaveLength(0);
    expect((input as HTMLTextAreaElement).value).toBe("");
  });

  it("opens help without an active backend session", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "",
          clientId: "client-1",
          commands: [{ name: "help", description: "도움말" }],
        }}
      >
        <MessageList />
        <ModalHost />
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "/help");
    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "명령어" })).toBeTruthy();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(startSession).not.toHaveBeenCalled();
    expect(document.querySelectorAll(".messages > article.message")).toHaveLength(0);
  });

  it("shows every enabled skill suggestion when the draft starts with dollar", async () => {
    const user = userEvent.setup();
    const skills = Array.from({ length: 10 }, (_, index) => ({
      name: `skill-${index + 1}`,
      description: `Skill ${index + 1}`,
      enabled: true,
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          skills,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "$");

    expect(screen.getAllByRole("option")).toHaveLength(skills.length);
    expect(screen.getByRole("option", { name: /\$skill-10/ })).toBeTruthy();
  });

  it("shows configured MCP servers in dollar suggestions", async () => {
    const user = userEvent.setup();

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          mcpServers: [
            { name: "sqlite_analysis", state: "connected", transport: "stdio", tool_count: 4, resource_count: 1 },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "$mcp:sq");

    const option = screen.getByRole("option", { name: /\$mcp:sqlite_analysis/ });
    expect(option.textContent).toContain("도구 4");

    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "$mcp:sqlite_analysis ");
  });

  it("classifies skill-mcp skills as MCP suggestions", async () => {
    const user = userEvent.setup();

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          skills: [
            { name: "browser-qa", description: "브라우저 MCP 라우팅", source: "skill-mcp:browser", enabled: true },
            { name: "browser-notes", description: "일반 브라우저 메모", source: "project", enabled: true },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "$mcp:bro");

    expect(screen.getByRole("option", { name: /\$mcp:browser-qa/ }).textContent).toContain("브라우저 MCP 라우팅");
    expect(screen.queryByRole("option", { name: /\$browser-notes/ })).toBeNull();

    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "$mcp:browser-qa ");
  });

  it("does not duplicate skill-mcp suggestions when a matching MCP server exists", async () => {
    const user = userEvent.setup();

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          mcpServers: [
            { name: "national-assembly", state: "connected", transport: "stdio" },
          ],
          skills: [
            {
              name: "national-assembly",
              description: "국회 MCP 라우팅",
              source: "skill-mcp:national-assembly",
              enabled: true,
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "$mcp:national");

    expect(screen.getAllByRole("option", { name: /\$mcp:national-assembly/ })).toHaveLength(1);
  });

  it("adds a trailing space after applying skill and file suggestions at the cursor", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          skills: [{ name: "design-review", description: "디자인 점검", enabled: true }],
          artifacts: [{ path: "outputs/report.md", name: "report.md", kind: "file" }],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...") as HTMLTextAreaElement;
    await user.type(input, "$des");
    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "$design-review ");

    await user.clear(input);
    await user.type(input, "@rep");
    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "@outputs/report.md ");
  });

  it("shows skill suggestions when dollar is typed in the middle of the draft", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          skills: [
            { name: "design-review", description: "디자인 점검", enabled: true },
            { name: "document-release", description: "릴리즈 문서", enabled: true },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "본문 중간 $des");

    expect(screen.getByRole("option", { name: /\$design-review/ })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /\$document-release/ })).toBeNull();
  });

  it("replaces only the active file token when applying a middle-of-draft suggestion", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          composer: { ...initialAppState.composer, draft: "이 파일 참고 @rep 해줘" },
          artifacts: [
            { path: "outputs/report.md", name: "report.md", kind: "file" },
            { path: "outputs/notes.md", name: "notes.md", kind: "file" },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...") as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange("이 파일 참고 @rep".length, "이 파일 참고 @rep".length);
    fireEvent.select(input);
    await user.click(screen.getByRole("option", { name: /@report\.md/ }));

    expect(input).toHaveProperty("value", "이 파일 참고 @outputs/report.md 해줘");
    expect(input.selectionStart).toBe("이 파일 참고 @outputs/report.md ".length);
  });

  it("uses the file path name for file suggestions when an artifact name is missing", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          artifacts: [
            { path: "outputs/fallback-report.html", kind: "html" } as any,
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...") as HTMLTextAreaElement;
    await user.type(input, "@fallback");

    const option = screen.getByRole("option", { name: /@fallback-report\.html/ });
    expect(option.textContent || "").toContain("outputs/fallback-report.html");
    expect(option.textContent || "").not.toContain("undefined");
  });

  it("grows the input and composer frame for multiline drafts", async () => {
    const user = userEvent.setup();
    const stylesheet = readStylesheet();
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...") as HTMLTextAreaElement;
    Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => (input.value.includes("\n") ? 44 : 20),
    });

    await user.type(input, "첫 줄{Shift>}{Enter}{/Shift}둘째 줄");

    expect(input.style.height).toBe("44px");
    expect(input.closest(".composer-box")?.classList.contains("multiline")).toBe(true);
    expect(stylesheet).toContain(".composer-expand-button {\n  display: grid;\n  place-items: center;\n  align-self: end;");
  });

  it("focuses the message input when the composer background is clicked", () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...") as HTMLTextAreaElement;
    const composerBox = input.closest(".composer-box") as HTMLElement;

    fireEvent.mouseDown(composerBox);

    expect(document.activeElement).toBe(input);
  });

  it("queues the draft with Ctrl+Enter while a response is running", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          busy: true,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "다음 질문");
    await user.keyboard("{Control>}{Enter}{/Control}");

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "다음 질문",
      mode: "queue",
      suppressUserTranscript: true,
    }));
  });

  it("sends the draft as steering with Enter while a response is running", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          busy: true,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "방금 조건 반영");
    await user.keyboard("{Enter}");

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "방금 조건 반영",
      mode: "steer",
      suppressUserTranscript: true,
    }));
  });

  it("shows a steering message immediately while send is still in flight", async () => {
    const user = userEvent.setup();
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise(() => {}));
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          busy: true,
          messages: [{ id: "assistant-1", role: "assistant", text: "작업 중", isComplete: false }],
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "이 조건 바로 반영");
    await user.keyboard("{Enter}");

    expect(document.querySelector(".message-kind-steering")?.textContent).toContain("이 조건 바로 반영");
  });

  it("jumps the message list to the bottom when Enter sends a draft after scrolling upward", async () => {
    const user = userEvent.setup();
    const scrollTopValues = new WeakMap<Element, number>();
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("messages") ? 900 : originalScrollHeight?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("messages") ? 120 : originalClientHeight?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValues.get(this) ?? originalScrollTop?.get?.call(this) ?? 0;
      },
      set(value: number) {
        scrollTopValues.set(this, value);
      },
    });

    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            sessionId: "session-1",
            clientId: "client-1",
            messages: [
              { id: "user-old", role: "user", text: "이전 질문" },
              { id: "assistant-old", role: "assistant", text: "이전 답변", isComplete: true },
            ],
            appSettings: {
              ...initialAppState.appSettings,
              streamScrollDurationMs: 0,
            },
          }}
        >
          <MessageList />
          <Composer />
        </AppStateProvider>,
      );

      const messages = document.querySelector(".messages") as HTMLElement;
      messages.scrollTop = 180;
      messages.dataset.lastScrollTop = "520";
      fireEvent.wheel(messages, { deltaY: -120 });

      await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "새 질문");
      await user.keyboard("{Enter}");

      await waitFor(() => expect(messages.scrollTop).toBe(900));
    } finally {
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
    }
  });

  it("clicks the send button as steering while a response is running and the draft has text", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          busy: true,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "지금 이 조건 반영");
    await user.click(screen.getByRole("button", { name: "스티어링 보내기" }));

    expect(cancelMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "지금 이 조건 반영",
      mode: "steer",
      suppressUserTranscript: true,
    }));
  });

  it("ignores duplicate form submits while the first send is being accepted", async () => {
    const user = userEvent.setup();
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise(() => {}));
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "2");
    const form = input.closest("form");
    expect(form).toBeTruthy();

    await act(async () => {
      fireEvent.submit(form!);
      fireEvent.submit(form!);
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "2",
      suppressUserTranscript: true,
    }));
  });

  it("suppresses backend user transcript when sending a long pasted text attachment", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    const pastedText = Array.from({ length: 21 }, (_, index) => `첨부 내용 ${index + 1}`).join("\n");
    await user.type(input, "이 내용 요약해줘");
    fireEvent.paste(input, {
      clipboardData: {
        items: [],
        getData: (type: string) => type === "text/plain" ? pastedText : "",
      },
    });
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: `이 내용 요약해줘\n\n[붙여넣은 텍스트 1]\n${pastedText}`,
      suppressUserTranscript: true,
    }));
  });

  it("allows another normal submit after the previous send request is accepted", async () => {
    const user = userEvent.setup();
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    function CaptureDispatch() {
      dispatch = useAppState().dispatch;
      return null;
    }
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
        }}
      >
        <CaptureDispatch />
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByRole("textbox");
    const form = input.closest("form");
    expect(form).toBeTruthy();

    await user.type(input, "first");
    fireEvent.submit(form!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));

    act(() => {
      dispatch({ type: "backend_event", event: { type: "line_complete" } });
    });

    await user.type(input, "second");
    fireEvent.submit(form!);

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "session-1",
      clientId: "client-1",
      line: "second",
    }));
  });

  it("shows the multi-user busy explanation when the server rejects a send", async () => {
    const user = userEvent.setup();
    vi.mocked(sendMessage).mockRejectedValueOnce(
      new Error("여러 명이 동시에 작업 중이라 서버가 바쁩니다. 다른 응답이 끝난 뒤 다시 시도하세요."),
    );

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "보고서 작성해줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(await screen.findAllByText(/여러 명이 동시에 작업 중이라 서버가 바쁩니다/)).not.toHaveLength(0);
  });

  it("starts a fresh backend only when sending after an idle new chat", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-old",
          clientId: "client-1",
          pendingFreshChat: true,
          workspacePath: "C:/demo",
          provider: "p-gpt",
          model: "gpt-5.4",
          effort: "high",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "새 질문");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith({
      clientId: "client-1",
      cwd: "C:/demo",
      activeProfile: "p-gpt",
      model: "gpt-5.4",
      effort: "high",
    }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-new",
      line: "새 질문",
    }));
  });

  it("shows a fresh-chat user message before the new backend session finishes starting", async () => {
    const user = userEvent.setup();
    let resolveStart!: (value: { sessionId: string }) => void;
    vi.mocked(startSession).mockReturnValueOnce(new Promise((resolve) => {
      resolveStart = resolve;
    }));

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-old",
          clientId: "client-1",
          pendingFreshChat: true,
          workspacePath: "C:/demo",
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "새 질문");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(document.querySelector("article.message.user")?.textContent).toContain("새 질문");
    expect(sendMessage).not.toHaveBeenCalled();

    await act(async () => {
      resolveStart({ sessionId: "session-new" });
    });

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-new",
      line: "새 질문",
    })));
  });

  it("does not flash the send button into stop state when toggling plan mode", async () => {
    const user = userEvent.setup();
    let resolvePlan!: (value: Record<string, unknown>) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise((resolve) => {
      resolvePlan = resolve;
    }));
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "작성 중");
    await user.keyboard("{Shift>}{Tab}{/Shift}");

    const planModeButton = screen.getByRole<HTMLButtonElement>("button", { name: "계획모드 전환" });
    expect(planModeButton.getAttribute("aria-pressed")).toBe("true");
    expect(planModeButton.classList.contains("hidden")).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "메시지 보내기" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "작업 중단" })).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      line: "/plan",
      suppressUserTranscript: true,
    }));

    await act(async () => {
      resolvePlan({ ok: true });
    });
  });

  it("renders the legacy stop button while a response is running without draft text", async () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          busy: true,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const stop = screen.getByRole<HTMLButtonElement>("button", { name: "작업 중단" });
    expect(stop.classList.contains("is-stop")).toBe(true);
    expect(stop.querySelector("circle")?.getAttribute("r")).toBe("8.5");
    expect(stop.querySelectorAll("path")).toHaveLength(2);

    await userEvent.click(stop);

    expect(cancelMessage).toHaveBeenCalledWith("session-1", "client-1");
  });

  it("shows a compact todo icon inside the composer when the checklist is collapsed", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          todoMarkdown: "- [x] 조사\n- [ ] 구현",
          todoCollapsed: true,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const todoButton = screen.getByRole("button", { name: "작업 목록 펼치기 1/2" });
    expect(todoButton.closest(".composer-box")).toBeTruthy();
    expect(document.querySelector(".todo-checklist-dock")).toBeNull();

    await user.click(todoButton);

    expect(screen.getByLabelText("작업 체크리스트")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "작업 목록 펼치기 1/2" })).toBeNull();
  });

  it("keeps the message tail pinned when the expanded checklist changes composer height", async () => {
    let dispatch!: ReturnType<typeof useAppState>["dispatch"];
    function AddTodoProbe() {
      dispatch = useAppState().dispatch;
      return <button type="button" onClick={() => dispatch({ type: "backend_event", event: { type: "todo_update", todo_markdown: "- [x] 조사\n- [ ] 작성" } })}>add todo</button>;
    }

    const scrollTopValues = new WeakMap<Element, number>();
    const originalScrollHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollHeight");
    const originalClientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
    const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTop");
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("messages") ? 900 : originalScrollHeight?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList?.contains("messages") ? 160 : originalClientHeight?.get?.call(this) ?? 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return scrollTopValues.get(this) ?? originalScrollTop?.get?.call(this) ?? 0;
      },
      set(value: number) {
        scrollTopValues.set(this, value);
      },
    });
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRectMock() {
      if (this.classList?.contains("composer")) {
        const hasTodo = Boolean(this.querySelector(".todo-checklist-dock"));
        return {
          x: 0,
          y: hasTodo ? 520 : 640,
          top: hasTodo ? 520 : 640,
          right: 800,
          bottom: 700,
          left: 0,
          width: 800,
          height: hasTodo ? 180 : 60,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            sessionId: "session-1",
            clientId: "client-1",
            messages: [
              { id: "user-1", role: "user", text: "보고서 작성해줘" },
              { id: "assistant-1", role: "assistant", text: "진행 중입니다.", isComplete: false },
            ],
          }}
        >
          <AddTodoProbe />
          <MessageList />
          <Composer />
        </AppStateProvider>,
      );

      const messages = document.querySelector(".messages") as HTMLElement;
      messages.scrollTop = 740;
      messages.dataset.lastScrollTop = "740";

      act(() => {
        dispatch({ type: "backend_event", event: { type: "todo_update", todo_markdown: "- [x] 조사\n- [ ] 작성" } });
      });

      await waitFor(() => expect(messages.scrollTop).toBe(900));
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
      if (originalScrollHeight) Object.defineProperty(HTMLElement.prototype, "scrollHeight", originalScrollHeight);
      if (originalClientHeight) Object.defineProperty(HTMLElement.prototype, "clientHeight", originalClientHeight);
      if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, "scrollTop", originalScrollTop);
    }
  });

  it("keeps the composer stack height stable when only the chat panel width changes", async () => {
    const originalResizeObserver = window.ResizeObserver;
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    const observers: Array<{
      callback: ResizeObserverCallback;
      elements: Element[];
    }> = [];
    let composerHeight = 60;
    let chatPanelWidth = 900;

    class MockResizeObserver {
      callback: ResizeObserverCallback;
      elements: Element[] = [];

      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
        observers.push(this);
      }

      observe(element: Element) {
        this.elements.push(element);
      }

      unobserve(element: Element) {
        this.elements = this.elements.filter((item) => item !== element);
      }

      disconnect() {
        this.elements = [];
      }
    }

    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRectMock(this: HTMLElement) {
      if (this.classList?.contains("composer")) {
        return {
          x: 0,
          y: 640,
          top: 640,
          right: 800,
          bottom: 640 + composerHeight,
          left: 0,
          width: 800,
          height: composerHeight,
          toJSON: () => ({}),
        };
      }
      if (this.classList?.contains("chat-panel")) {
        return {
          x: 0,
          y: 0,
          top: 0,
          right: chatPanelWidth,
          bottom: 720,
          left: 0,
          width: chatPanelWidth,
          height: 720,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      render(
        <AppStateProvider>
          <main className="chat-panel">
            <section className="messages" />
            <Composer />
          </main>
        </AppStateProvider>,
      );

      expect(document.documentElement.style.getPropertyValue("--composer-stack-height")).toBe("60px");

      composerHeight = 120;
      chatPanelWidth = 520;
      const chatPanel = document.querySelector(".chat-panel") as HTMLElement;
      const chatPanelObserver = observers.find((observer) => observer.elements.includes(chatPanel));
      expect(chatPanelObserver).toBeTruthy();

      act(() => {
        chatPanelObserver?.callback([{ target: chatPanel } as unknown as ResizeObserverEntry], chatPanelObserver as unknown as ResizeObserver);
      });
      await act(async () => {
        await new Promise((resolve) => window.requestAnimationFrame(resolve));
      });

      expect(document.documentElement.style.getPropertyValue("--composer-stack-height")).toBe("60px");
    } finally {
      window.ResizeObserver = originalResizeObserver;
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("does not render the AI team button inside the composer controls", () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".composer-box .swarm-command")).toBeNull();
    expect(screen.queryByRole("button", { name: "AI 팀 열기" })).toBeNull();
  });

  it("does not show a dismiss button on the expanded todo checklist", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          todoMarkdown: "- [x] 조사\n- [ ] 구현",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".todo-checklist-dock")).toBeTruthy();
    expect(screen.getByRole("button", { name: "작업 목록 접기" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "작업 목록 닫기" })).toBeNull();
  });

  it("renders checklist status marks without interactive checkboxes", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          todoMarkdown: "- [x] 조사\n- [ ] 구현",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(document.querySelectorAll(".todo-checkmark")).toHaveLength(2);
    expect(screen.getByText("(완료) 조사")).toBeTruthy();
  });

  it("shows live workflow activity under the running checklist item", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          todoMarkdown: "- [x] 테이블 구조 확인\n- [ ] 분석 결과 정리",
          statusText: "분석 결과를 보고서 구조로 정리하고 있습니다.",
          workflowEvents: [
            {
              id: "workflow-1",
              toolName: "mcp__sqlite_analysis__run_query",
              title: "쿼리 실행",
              detail: "업종별 실업률 변동성을 계산했습니다.",
              detailLog: ["unemployment_industries 테이블 범위를 확인했습니다."],
              status: "done",
              role: "activity",
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const runningItem = screen.getByText("분석 결과 정리").closest("li");
    expect(runningItem?.classList.contains("running")).toBe(true);
    expect(screen.getByLabelText("현재 작업 진행")).toBeTruthy();
    expect(screen.getByText("unemployment_industries 테이블 범위를 확인했습니다.")).toBeTruthy();
    expect(screen.getByText("분석 결과를 보고서 구조로 정리하고 있습니다.")).toBeTruthy();
  });

  it("shows only the three most recent live workflow activity lines", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          todoMarkdown: "- [x] 범위 확인\n- [x] 구조 설계\n- [x] 우선순위 정리\n- [ ] HTML 보고서 작성",
          statusText: "파일 작업 중",
          workflowEvents: [
            {
              id: "workflow-1",
              toolName: "",
              title: "진행 상황",
              detail: "보고서 범위와 활용 관점을 정리했습니다.",
              status: "done",
              role: "activity",
            },
            {
              id: "workflow-2",
              toolName: "",
              title: "진행 상황",
              detail: "포스코 업무 시나리오별 법무·규제 활용 구조화",
              status: "done",
              role: "activity",
            },
            {
              id: "workflow-3",
              toolName: "",
              title: "진행 상황",
              detail: "시각 구성·표·우선순위 매트릭스 설계",
              status: "done",
              role: "activity",
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const activityLines = [...document.querySelectorAll(".todo-activity-line")]
      .map((line) => line.textContent);
    expect(activityLines).toEqual([
      "포스코 업무 시나리오별 법무·규제 활용 구조화",
      "시각 구성·표·우선순위 매트릭스 설계",
      "파일 작업 중",
    ]);
  });

  it("does not mirror follow-up wait copy under the running checklist item", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          todoMarkdown: "- [x] 테이블 구조 확인\n- [ ] 분석 결과 정리",
          statusText: "AI 후속 응답 대기 중",
          workflowEvents: [
            {
              id: "workflow-query",
              toolName: "mcp__sqlite_analysis__run_query",
              title: "쿼리 실행",
              detail: "노선별 지표를 계산했습니다.",
              status: "done",
              role: "activity",
            },
            {
              id: "workflow-wait",
              toolName: "",
              title: "후속 응답 대기",
              detail: "AI 응답 대기 중입니다. 도구 실행은 완료됐고, 결과를 모델에 전달했습니다. 추가 도구 호출이나 최종 답변 이벤트를 기다립니다.",
              detailLog: [
                "AI 응답 대기 중입니다. 도구 실행은 완료됐고, 결과를 모델에 전달했습니다. 추가 도구 호출이나 최종 답변 이벤트를 기다립니다.",
              ],
              status: "running",
              role: "activity",
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const activity = screen.getByLabelText("현재 작업 진행");
    expect(activity.textContent || "").toContain("노선별 지표를 계산했습니다.");
    expect(activity.textContent || "").not.toContain("AI 후속 응답 대기 중");
    expect(activity.textContent || "").not.toContain("추가 도구 호출이나 최종 답변 이벤트를 기다립니다.");
  });

  it("keeps failed and empty-result workflow noise out of the running checklist item", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          todoMarkdown: "- [x] 원문 링크 수집\n- [ ] 관련 링크 분석",
          statusText: "관련 링크의 핵심 정보를 정리하고 있습니다.",
          workflowEvents: [
            {
              id: "workflow-success",
              toolName: "web_search",
              title: "웹 검색",
              detail: "공식 발표 자료 3건을 확인했습니다.",
              status: "done",
              role: "activity",
            },
            {
              id: "workflow-empty",
              toolName: "web_search",
              title: "웹 검색",
              detail: "검색 결과가 없습니다.",
              detailLog: ["검색 결과가 없습니다.", "필요한 번역이나 명령을 실행하고 있습니다."],
              status: "error",
              role: "activity",
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const activity = screen.getByLabelText("현재 작업 진행");
    expect(activity.textContent || "").toContain("공식 발표 자료 3건을 확인했습니다.");
    expect(activity.textContent || "").toContain("관련 링크의 핵심 정보를 정리하고 있습니다.");
    expect(activity.textContent || "").not.toContain("검색 결과가 없습니다.");
    expect(activity.textContent || "").not.toContain("필요한 번역이나 명령을 실행하고 있습니다.");
  });

  it("shows disabled long report workflow as ordinary activity in the checklist", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          busy: true,
          todoMarkdown: "- [x] 데이터 분석\n- [ ] 초장문 웹보고서 생성 및 저장",
          workflowEvents: [
            {
              id: "workflow-report",
              toolName: "write_long_report",
              title: "write_long_report",
              detail: "파일 작업 중... 2분 13초 경과",
              status: "running",
              level: "child",
              toolInput: {
                phase: "outline",
                phase_label: "보고서 뼈대 생성 중",
                target_tokens: 40000,
                output_path: "outputs/report.html",
                content: "<!doctype html><h1>산업별 실업률 분석</h1>",
                intermediate_files: [
                  {
                    path: "outputs/report.intermediate/design_brief.md",
                    label: "design-brief",
                  },
                  {
                    path: "outputs/report.intermediate/sections/01_개요.draft.md",
                    label: "section-01-draft",
                  },
                ],
              },
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const activity = screen.getByLabelText("현재 작업 진행");
    expect(activity.textContent || "").toContain("파일 작업 중... 2분 13초 경과");
    expect(activity.textContent || "").not.toContain("보고서 뼈대 생성 중");
    expect(activity.textContent || "").not.toContain("중간 산출물");
    expect(activity.textContent || "").not.toContain("다음 작업을 정했습니다.");
  });

  it("hides a checklist from a different chat session", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-current",
          activeHistoryId: "session-old",
          todoMarkdown: "- [x] 이전 세션 작업\n- [x] 완료",
          todoSessionId: "session-current",
          todoCollapsed: false,
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.queryByText("작업 목록")).toBeNull();
    expect(screen.queryByText("(완료) 이전 세션 작업")).toBeNull();
  });

  it("renders backend questions inline directly above the composer input", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: "어떤 색으로 진행할까요?",
              choices: [
                { label: "파랑", value: "blue", description: "차분한 느낌" },
                { label: "초록", value: "green" },
              ],
            },
          },
        }}
      >
        <Composer />
        <ModalHost />
      </AppStateProvider>,
    );

    const card = document.querySelector(".inline-question-card");
    const composerBox = document.querySelector(".composer-box");
    expect(card).toBeTruthy();
    expect(card?.nextElementSibling).toBe(composerBox);
    expect(screen.queryByRole("dialog", { name: "질문" })).toBeNull();
    expect(screen.getByText("Q1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /파랑/ }));

    expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
      type: "question_response",
      request_id: "question-1",
      answer: "blue",
    });
  });

  it("does not attach generic quick replies to open-ended backend questions", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: "웹보고서 제작에 앞서 방향만 짧게 확인하겠습니다. 인터넷 문화의 변천사를 어떤 관점으로 보고서화할까요?",
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /네, 진행해주세요/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /아니요/ })).toBeNull();
    expect(screen.getByPlaceholderText("직접 답변 입력...")).toBeTruthy();
  });

  it("reserves bottom scroll space for inline questions above the composer input", () => {
    const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function mockRect(this: HTMLElement) {
      if (this.classList.contains("composer")) {
        return {
          x: 0,
          y: 500,
          top: 500,
          right: 800,
          bottom: 700,
          left: 0,
          width: 800,
          height: 200,
          toJSON: () => ({}),
        };
      }
      if (this.classList.contains("composer-box")) {
        return {
          x: 0,
          y: 640,
          top: 640,
          right: 800,
          bottom: 700,
          left: 0,
          width: 800,
          height: 60,
          toJSON: () => ({}),
        };
      }
      return originalGetBoundingClientRect.call(this);
    };

    try {
      render(
        <AppStateProvider
          initialState={{
            ...initialAppState,
            sessionId: "session-1",
            clientId: "client-1",
            modal: {
              kind: "backend",
              payload: {
                kind: "question",
                request_id: "question-1",
                question: "이 방향으로 바로 수정해도 될까요?",
              },
            },
          }}
        >
          <Composer />
        </AppStateProvider>,
      );

      expect(document.querySelector(".inline-question-card")).toBeTruthy();
      expect(document.documentElement.style.getPropertyValue("--composer-stack-height")).toBe("200px");
    } finally {
      HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    }
  });

  it("does not infer inline replies from completed assistant confirmation text", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "3번 혼합형을 추천드립니다.\n\n이 방향으로 바로 진행해도 될까요?",
              isComplete: true,
            },
          ],
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText("답변 선택")).toBeNull();
  });

  it("does not infer inline replies from completed assistant clarification text", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "진행 전에 한 가지만 확인하겠습니다.\n\n보고서의 대상 독자는 누구인가요?",
              isComplete: true,
            },
          ],
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText("답변 선택")).toBeNull();
  });

  it("does not turn generic greeting assistance prompts into inline replies", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "안녕하세요! 무엇을 도와드릴까요?",
              isComplete: true,
            },
          ],
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText("답변 선택")).toBeNull();
  });

  it.each([
    "추가로 궁금한 점이 있으신가요?",
    "더 도와드릴 일이 있을까요?",
    "이 설명에서 헷갈리는 부분이 있나요?",
    "이 부분이 왜 중요할까요?",
  ])("does not infer inline replies from generic assistant questions: %s", (text) => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text,
              isComplete: true,
            },
          ],
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText("답변 선택")).toBeNull();
  });

  it("does not infer inline replies from batched assistant clarification text", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: [
                "(1/3) 보고서의 대상 독자는 누구인가요?",
                "(2/3) 원하는 톤은 어떻게 할까요?",
                "(3/3) 분량은 어느 정도가 좋을까요?",
              ].join("\n"),
              isComplete: true,
            },
          ],
        }}
      >
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText("답변 입력 (3개)")).toBeNull();
  });

  it("shows progress for batched backend clarification questions", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "보고서의 대상 독자는 누구인가요?",
                "원하는 톤은 어떻게 할까요?",
                "분량은 어느 정도가 좋을까요?",
              ].join("\n"),
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.getByText("질문 (1/3)")).toBeTruthy();
    expect(screen.getByText("보고서의 대상 독자는 누구인가요?")).toBeTruthy();
    expect(screen.queryByText("원하는 톤은 어떻게 할까요?")).toBeNull();
    expect(screen.queryByText("분량은 어느 정도가 좋을까요?")).toBeNull();
  });

  it("renders batched backend clarification questions one at a time", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "(1/3) 피해금액은 얼마인가요?",
                "(2/3) 송금한 날짜와 시간은 언제인가요?",
                "(3/3) 현재 상태는 무엇인가요?",
              ].join("\n"),
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.getByText("질문 (1/3)")).toBeTruthy();
    expect(screen.getByText("피해금액은 얼마인가요?")).toBeTruthy();
    expect(screen.queryByText("송금한 날짜와 시간은 언제인가요?")).toBeNull();

    await user.type(screen.getByPlaceholderText("답변 입력..."), "10만원");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByText("질문 (2/3)")).toBeTruthy();
    expect(screen.getByText("송금한 날짜와 시간은 언제인가요?")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("답변 입력..."), "2026-05-05 10시");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByText("질문 (3/3)")).toBeTruthy();
    expect(screen.getByText("현재 상태는 무엇인가요?")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("답변 입력..."), "연락두절");
    await user.click(screen.getByRole("button", { name: "답변" }));

    await waitFor(() => {
      expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
        type: "question_response",
        request_id: "question-1",
        answer: [
          "(1/3) 피해금액은 얼마인가요?\n답변: 10만원",
          "(2/3) 송금한 날짜와 시간은 언제인가요?\n답변: 2026-05-05 10시",
          "(3/3) 현재 상태는 무엇인가요?\n답변: 연락두절",
        ].join("\n\n"),
      });
    });
  });

  it("renders batched multiple-choice backend questions one at a time with choices", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "(1/3) 피해금액은 얼마인가요?",
                "(2/3) 송금한 날짜와 시간은 언제인가요?",
                "(3/3) 현재 상태는 무엇인가요?",
              ].join("\n"),
              choices: [
                { label: "직접 입력 양식", value: "직접 입력 양식", description: "빈칸을 채워서 답변합니다." },
                { label: "정보가 아직 부족함", value: "정보가 아직 부족함" },
              ],
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.getByText("질문 (1/3)")).toBeTruthy();
    expect(screen.getByText("피해금액은 얼마인가요?")).toBeTruthy();
    expect(screen.queryByText("송금한 날짜와 시간은 언제인가요?")).toBeNull();
    expect(screen.queryByPlaceholderText("답변 입력...")).toBeNull();
    expect(screen.getByPlaceholderText("기타 직접 입력...")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /정보가 아직 부족함/ }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByText("질문 (2/3)")).toBeTruthy();
    expect(screen.getByText("송금한 날짜와 시간은 언제인가요?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /직접 입력 양식/ }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByText("질문 (3/3)")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("기타 직접 입력..."), "연락두절");
    await user.click(screen.getByRole("button", { name: "직접 답변 보내기" }));

    await waitFor(() => {
      expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
        type: "question_response",
        request_id: "question-1",
        answer: [
          "(1/3) 피해금액은 얼마인가요?\n답변: 정보가 아직 부족함",
          "(2/3) 송금한 날짜와 시간은 언제인가요?\n답변: 직접 입력 양식",
          "(3/3) 현재 상태는 무엇인가요?\n답변: 연락두절",
        ].join("\n\n"),
      });
    });
  });

  it("does not duplicate visible numbering when backend choice labels already include list markers", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "오늘 답변은 어떤 톤으로 드릴까요?",
                "제가 다음에 해볼 테스트 유형을 골라주세요.",
              ].join("\n"),
              choices: [
                { label: "1. 친근한 톤 + 짧은 선택형", value: "1. 친근한 톤 + 짧은 선택형", description: "가볍고 빠른 UI 확인용" },
                { label: "2. 전문적인 톤 + 일괄 질문", value: "2. 전문적인 톤 + 일괄 질문", description: "실제 업무형 역질문 UI 확인용" },
              ],
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("답변 입력..."), "친근하게");
    await user.click(screen.getByRole("button", { name: "답변" }));

    expect(screen.getByRole("button", { name: /A1\s*친근한 톤 \+ 짧은 선택형/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /A1\s*1\.\s*친근한 톤/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /A1\s*1\s+친근한 톤/ })).toBeNull();
  });

  it("only gives text inputs to batched questions that are not answered by quick choices", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "오늘 답변은 어떤 톤으로 드릴까요?",
                "제가 다음에 해볼 테스트 유형을 골라주세요.",
              ].join("\n"),
              choices: [
                { label: "친근한 톤 + 짧은 선택형", value: "친근한 톤 + 짧은 선택형" },
                { label: "전문적인 톤 + 일괄 질문", value: "전문적인 톤 + 일괄 질문" },
              ],
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.getByPlaceholderText("답변 입력...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /A1\s*친근한 톤 \+ 짧은 선택형/ })).toBeNull();

    await user.type(screen.getByPlaceholderText("답변 입력..."), "친근하게");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(screen.queryByPlaceholderText("답변 입력...")).toBeNull();
    await user.click(screen.getByRole("button", { name: /A1\s*친근한 톤 \+ 짧은 선택형/ }));

    await waitFor(() => {
      expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
        type: "question_response",
        request_id: "question-1",
        answer: [
          "(1/2) 오늘 답변은 어떤 톤으로 드릴까요?\n답변: 친근하게",
          "(2/2) 제가 다음에 해볼 테스트 유형을 골라주세요.\n답변: 친근한 톤 + 짧은 선택형",
        ].join("\n\n"),
      });
    });
  });

  it("lets batched multiple-choice backend questions submit a custom objective answer", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "(1/2) 확인할 동작은 무엇인가요?",
                "(2/2) 어떤 답변 형태가 편한가요?",
              ].join("\n"),
              choices: [
                { label: "짧은 한 문장 답변", value: "짧은 한 문장 답변" },
                { label: "불릿 목록 답변", value: "불릿 목록 답변" },
              ],
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("답변 입력..."), "확인할 동작 정리");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(screen.queryByPlaceholderText("답변 입력...")).toBeNull();
    expect(screen.getByText("질문 (2/2)")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("기타 직접 입력..."), "표와 짧은 설명 혼합");
    await user.click(screen.getByRole("button", { name: "직접 답변 보내기" }));

    expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
      type: "question_response",
      request_id: "question-1",
      answer: [
        "(1/2) 확인할 동작은 무엇인가요?\n답변: 확인할 동작 정리",
        "(2/2) 어떤 답변 형태가 편한가요?\n답변: 표와 짧은 설명 혼합",
      ].join("\n\n"),
    });
  });

  it("keeps subjective inputs when batched questions mix subjective and multiple-choice prompts", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "주관식: 지금 테스트하려는 역질문 UI에서 가장 확인하고 싶은 동작은 무엇인가요?",
                "객관식: 아래 중 어떤 답변 형태가 가장 편한가요?",
              ].join("\n"),
              choices: [
                { label: "짧은 한 문장 답변", value: "짧은 한 문장 답변" },
                { label: "불릿 목록 답변", value: "불릿 목록 답변" },
              ],
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("답변 입력...");
    expect(input).toBeTruthy();

    await user.type(input, "주관식 입력칸 유지");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(screen.getByText("질문 (2/2)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /불릿 목록 답변/ }));

    await waitFor(() => {
      expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
        type: "question_response",
        request_id: "question-1",
        answer: [
          "(1/2) 주관식: 지금 테스트하려는 역질문 UI에서 가장 확인하고 싶은 동작은 무엇인가요?\n답변: 주관식 입력칸 유지",
          "(2/2) 객관식: 아래 중 어떤 답변 형태가 가장 편한가요?\n답변: 불릿 목록 답변",
        ].join("\n\n"),
      });
    });
  });

  it("lets mixed subjective and multiple-choice prompts use a custom objective answer", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          modal: {
            kind: "backend",
            payload: {
              kind: "question",
              request_id: "question-1",
              question: [
                "주관식: 확인하고 싶은 동작은 무엇인가요?",
                "객관식: 어떤 답변 형태가 가장 편한가요?",
              ].join("\n"),
              choices: [
                { label: "짧은 한 문장 답변", value: "짧은 한 문장 답변" },
                { label: "불릿 목록 답변", value: "불릿 목록 답변" },
              ],
            },
          },
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("답변 입력..."), "혼합형 입력 확인");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(screen.getByText("질문 (2/2)")).toBeTruthy();

    await user.type(screen.getByPlaceholderText("기타 직접 입력..."), "표 형태 답변");
    await user.click(screen.getByRole("button", { name: "직접 답변 보내기" }));

    await waitFor(() => {
      expect(sendBackendRequest).toHaveBeenCalledWith("session-1", "client-1", {
        type: "question_response",
        request_id: "question-1",
        answer: [
          "(1/2) 주관식: 확인하고 싶은 동작은 무엇인가요?\n답변: 혼합형 입력 확인",
          "(2/2) 객관식: 어떤 답변 형태가 가장 편한가요?\n답변: 표 형태 답변",
        ].join("\n\n"),
      });
    });
  });

  it("does not turn markdown answer headings into inline follow-up questions", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: [
                "맞습니다. 구조적으로 보면 이렇습니다.",
                "",
                "## 왜 AI가 PPT를 기본 상태에서 잘 못 만들까?",
                "",
                "PPT는 텍스트보다 레이아웃 검수가 중요한 문서입니다.",
                "",
                "## PPTX가 왜 프리뷰 안 되나?",
                "",
                "PPTX는 브라우저가 직접 렌더링하기 어려운 Office 패키지입니다.",
              ].join("\n"),
              isComplete: true,
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText(/질문:/)).toBeNull();
  });

  it("does not infer inline replies from assistant alternative questions", () => {
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-1",
          clientId: "client-1",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              text: "“DCInside 트이전글”을 기준으로 보면 될까요, 아니면 구글/웹 검색에 노출되는 외부 요약까지 포함한 넓은 웹 담론으로 볼까요?",
              isComplete: true,
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    expect(document.querySelector(".inline-question-card")).toBeNull();
    expect(screen.queryByText("답변 선택")).toBeNull();
  });
});
