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
import { cancelMessage, enhancePrompt, sendBackendRequest, sendMessage, uploadClientAttachments } from "../../api/messages";
import { startSession } from "../../api/session";

vi.mock("../../api/messages", () => ({
  enhancePrompt: vi.fn().mockResolvedValue({ text: "개선한 요청" }),
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

function BusyProbe() {
  const { state } = useAppState();
  return <output data-testid="busy-state">{String(state.busy)}</output>;
}

function SwitchSessionProbe() {
  const { state, dispatch } = useAppState();
  return <><button onClick={() => dispatch({ type: "session_started", sessionId: "session-b", busy: true, replay: true, savedSessionId: "history-b" })}>Switch session</button>
    <output data-testid="session-state">{state.sessionId}:{String(state.busy)}</output></>;
}

function AttachmentEchoProbe() {
  const { dispatch } = useAppState();
  return <button onClick={() => dispatch({ type: "backend_event", event: {
    type: "transcript_item", item: { role: "user", text: "[image attachments: 1]" },
  } })}>Replay attachment echo</button>;
}

describe("Composer", () => {
  it("waits for backend completion after cancel acknowledgement before sending the next message", async () => {
    function Complete() {
      const { dispatch } = useAppState();
      return <button onClick={() => dispatch({ type: "backend_event", event: { type: "line_complete" } })}>Backend stopped</button>;
    }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy: true }}><Composer /><BusyProbe /><Complete /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "작업 중단" }));
    expect(cancelMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("busy-state").textContent).toBe("true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next request" } });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    expect(sendMessage).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Next request");
    fireEvent.click(screen.getByText("Backend stopped"));
    await act(async () => fireEvent.submit(document.querySelector("form")!));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ line: "Next request" }));
    expect(vi.mocked(sendMessage).mock.calls[0][0].mode).toBeUndefined();
  });

  it("releases the cancellation wait if the cancellation request fails", async () => {
    vi.mocked(cancelMessage).mockRejectedValueOnce(new Error("Cancel delivery failed"));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy: true }}><Composer /><BusyProbe /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "작업 중단" }));
    expect(screen.getByTestId("busy-state").textContent).toBe("true");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Updated instruction" } });
    expect((screen.getByRole("button", { name: "스티어링 보내기" }) as HTMLButtonElement).disabled).toBe(false);
    await act(async () => fireEvent.submit(document.querySelector("form")!));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ line: "Updated instruction", mode: "steer" }));
  });

  it.each([false, true])("does not cancel a running response when Enter repeats after submission (ctrl %s)", async (ctrlKey) => {
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy: true, composer: { ...initialAppState.composer, draft: "추가 요청" } }}><Composer /></AppStateProvider>);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey, repeat: true });
    expect(cancelMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it("delivers overlapping additional-message submits only once and preserves the next draft", async () => {
    let finish!: (value: { ok: boolean }) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy: true, composer: { ...initialAppState.composer, draft: "First follow-up" } }}><Composer /></AppStateProvider>);
    const form = document.querySelector("form")!;
    act(() => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next follow-up" } });
    fireEvent.submit(form);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Next follow-up");
    await act(async () => finish({ ok: true }));
    fireEvent.submit(form);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({ line: "Next follow-up" }));
  });

  it("keeps explicit cancellation available while additional-message delivery is pending", async () => {
    let finish!: (value: { ok: boolean }) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy: true, composer: { ...initialAppState.composer, draft: "Follow-up" } }}><Composer /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    fireEvent.submit(document.querySelector("form")!);
    expect(cancelMessage).toHaveBeenCalledTimes(1);
    await act(async () => finish({ ok: true }));
  });

  it.each([
    [false, false, true, 13], [false, true, true, 13], [true, false, true, 13], [true, true, true, 13],
    [false, false, false, 229], [true, false, false, 229], [true, true, false, 229],
  ])("keeps IME Enter in the editor (busy %s, ctrl %s, composing %s, code %s)", (busy, ctrlKey, isComposing, keyCode) => {
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy: Boolean(busy), composer: { ...initialAppState.composer, draft: "검토 중인 한글" } }}><Composer /></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    const unhandled = fireEvent.keyDown(input, { key: "Enter", ctrlKey, isComposing, keyCode });
    expect(unhandled).toBe(true);
    expect(input.value).toBe("검토 중인 한글");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(cancelMessage).not.toHaveBeenCalled();
  });

  it.each(["send", "steer", "missing-session", "help", "cancel", "cancel-error"])("ignores delayed %s results after a fresh chat reuses the backend", async (operation) => {
    let reject!: (error: Error) => void;
    let resolve!: (result: { ok: boolean }) => void;
    const pending = new Promise<{ ok: boolean }>((res, rej) => { resolve = res; reject = rej; });
    if (operation.startsWith("cancel")) vi.mocked(cancelMessage).mockReturnValueOnce(pending);
    else vi.mocked(sendMessage).mockReturnValueOnce(pending);
    let current = initialAppState;
    function NewChat() {
      const { state, dispatch } = useAppState();
      current = state;
      return <button onClick={() => {
        dispatch({ type: "begin_new_chat" });
        dispatch({ type: "set_busy", value: true });
      }}>Fresh running chat</button>;
    }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", busy: operation === "steer" || operation.startsWith("cancel"),
      composer: { ...initialAppState.composer, draft: operation.startsWith("cancel") ? "" : operation === "help" ? "/help" : "Old request" },
    }}><Composer /><NewChat /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    fireEvent.click(screen.getByText("Fresh running chat"));
    await act(async () => {
      if (operation === "cancel") resolve({ ok: true });
      else reject(new Error(operation === "missing-session" ? "Unknown session" : "Old failure"));
    });
    expect(current.busy).toBe(true);
    expect(current.messages).toEqual([]);
    expect(current.modal).toBeNull();
    expect(current.composer.draft).toBe("");
    expect(startSession).not.toHaveBeenCalled();
  });

  it.each(["fresh", "history"])("does not adopt a delayed backend after navigation to %s", async (destination) => {
    let finish!: (value: { sessionId: string }) => void;
    vi.mocked(startSession).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    let current = initialAppState;
    function Navigate() {
      const { state, dispatch } = useAppState();
      current = state;
      return <button onClick={() => {
        dispatch(destination === "fresh" ? { type: "begin_new_chat" } : { type: "begin_history_restore", sessionId: "different-history" });
        dispatch({ type: "set_draft", value: "New conversation draft" });
      }}>Navigate</button>;
    }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", pendingFreshChat: true,
      composer: { ...initialAppState.composer, draft: "Old request" },
    }}><Composer /><Navigate /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    fireEvent.click(screen.getByText("Navigate"));
    await act(async () => finish({ sessionId: "obsolete-start" }));
    expect(current.sessionId).toBe("session-a");
    expect(current.composer.draft).toBe("New conversation draft");
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it.each(["send", "recovered-send", "start"])("restores text and attachments for a manual retry after %s failure", async (failure) => {
    if (failure === "recovered-send") vi.mocked(sendMessage).mockRejectedValueOnce(new Error("Unknown session"));
    if (failure === "start") vi.mocked(startSession).mockRejectedValueOnce(new Error("offline"));
    else vi.mocked(sendMessage).mockRejectedValueOnce(new Error("offline"));
    const image = { name: "capture.png", media_type: "image/png", data: "aW1hZ2U=" };
    const uploaded = { id: "reference", name: "reference.pdf", path: "uploads/reference.pdf", size: 42, media_type: "application/pdf" };
    vi.mocked(uploadClientAttachments).mockResolvedValueOnce({ attachments: [uploaded] });
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", clientId: "client",
      pendingFreshChat: failure === "start",
      composer: { draft: "Use these sources", attachments: [image], pastedTexts: ["Additional source text"], token: null },
    }}><Composer /></AppStateProvider>);
    await userEvent.upload(document.querySelector<HTMLInputElement>(".composer-file-input")!, new File(["pdf"], "reference.pdf", { type: "application/pdf" }));
    await userEvent.click(screen.getByRole("button", { name: "분석 범위" }));
    await userEvent.click(screen.getByRole("button", { name: /심층/ }));
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Use these sources"));
    expect(screen.getByRole("button", { name: "capture.png" })).toBeTruthy();
    expect(screen.getByText("reference.pdf")).toBeTruthy();
    const callsBeforeRetry = vi.mocked(sendMessage).mock.calls.length;
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(callsBeforeRetry + 1));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      line: "Use these sources\n\n[붙여넣은 텍스트 1]\nAdditional source text",
      attachments: [image], attachmentRefs: [uploaded],
      composeOptions: { analysis_depth: "deep" },
    }));
  });

  it("does not overwrite a new draft after an earlier send fails", async () => {
    let rejectSend!: (error: Error) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSend = reject; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", composer: { ...initialAppState.composer, draft: "First request" } }}><Composer /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New draft" } });
    await act(async () => rejectSend(new Error("offline")));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("New draft");
  });

  it("does not restore an old request into a fresh chat using the same backend", async () => {
    let rejectSend!: (error: Error) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSend = reject; }));
    function NewChat() {
      const { dispatch } = useAppState();
      return <button onClick={() => dispatch({ type: "begin_new_chat" })}>Fresh chat</button>;
    }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", composer: { ...initialAppState.composer, draft: "Old request" } }}><Composer /><NewChat /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    fireEvent.click(screen.getByText("Fresh chat"));
    await act(async () => rejectSend(new Error("offline")));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not mark a newer turn idle when an old cancellation response arrives", async () => {
    let finishCancel!: (value: { ok: boolean }) => void;
    vi.mocked(cancelMessage).mockReturnValueOnce(new Promise((resolve) => { finishCancel = resolve; }));
    function NextTurn() {
      const { dispatch } = useAppState();
      return <button onClick={() => {
        dispatch({ type: "backend_event", event: { type: "line_complete" } });
        dispatch({ type: "backend_event", event: { type: "transcript_item", item: { role: "user", text: "New turn" } } });
        dispatch({ type: "set_busy", value: true });
      }}>Next turn</button>;
    }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", busy: true }}><Composer /><BusyProbe /><NextTurn /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    fireEvent.click(screen.getByText("Next turn"));
    await act(async () => { finishCancel({ ok: true }); });
    expect(screen.getByTestId("busy-state").textContent).toBe("true");
  });
  it.each(["queue", "steer"])("keeps the running answer intact when %s delivery fails and allows retry", async (mode) => {
    let rejectSend!: (reason: Error) => void;
    vi.mocked(sendMessage).mockReturnValueOnce(new Promise((_resolve, reject) => { rejectSend = reject; }));
    let latest = initialAppState;
    function Observe() { latest = useAppState().state; return null; }
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", busy: true }}><Composer /><Observe /></AppStateProvider>);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "추가 지시" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: mode === "queue" });
    await act(async () => { rejectSend(new Error("delivery unavailable")); });
    expect(latest.busy).toBe(true);
    expect(latest.messages.some((message) => message.pendingRequestId)).toBe(false);
    expect((input as HTMLTextAreaElement).value).toBe("추가 지시");
    expect(latest.modal?.kind).toBe("error");
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: mode === "queue" });
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
  });
  it.each([false, true])("waits for all pasted images before sending (busy=%s)", async (busy) => {
    const readers: FileReader[] = [];
    const spy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { readers.push(this); });
    function Complete() {
      const { dispatch } = useAppState();
      return <button onClick={() => dispatch({ type: "backend_event", event: { type: "line_complete" } })}>Complete current work</button>;
    }
    try {
      render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", busy,
        composer: { ...initialAppState.composer, draft: "Compare the images" },
      }}><Composer /><Complete /></AppStateProvider>);
      const input = screen.getByRole("textbox");
      act(() => {
        for (const name of ["first.png", "second.png"]) {
          const file = new File(["image"], name, { type: "image/png" });
          fireEvent.paste(input, { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" } });
        }
        fireEvent.keyDown(input, { key: "Enter", ctrlKey: busy });
        fireEvent.submit(document.querySelector("form")!);
      });
      expect(sendMessage).not.toHaveBeenCalled();
      expect(cancelMessage).not.toHaveBeenCalled();
      for (let index = 0; index < readers.length; index += 1) {
        await act(async () => {
          Object.defineProperty(readers[index], "result", { value: `data:image/png;base64,aW1hZ2U${index}` });
          readers[index].onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
        });
        if (index === 0) {
          fireEvent.submit(document.querySelector("form")!);
          expect(sendMessage).not.toHaveBeenCalled();
        }
      }
      if (busy) fireEvent.click(screen.getByText("Complete current work"));
      await act(async () => fireEvent.submit(document.querySelector("form")!));
      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(vi.mocked(sendMessage).mock.calls[0][0].attachments).toEqual([
        expect.objectContaining({ name: "first.png" }), expect.objectContaining({ name: "second.png" }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it("ignores an image read that finishes after switching conversations", async () => {
    let reader!: FileReader;
    const spy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { reader = this; });
    try {
      render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a" }}><Composer /><SwitchSessionProbe /></AppStateProvider>);
      const file = new File(["image"], "old-image.png", { type: "image/png" });
      fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => file }], getData: () => "" } });
      fireEvent.click(screen.getByText("Switch session"));
      await act(async () => {
        Object.defineProperty(reader, "result", { value: "data:image/png;base64,aW1hZ2U=" });
        reader.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
      });
      expect(screen.queryByRole("button", { name: "old-image.png" })).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it.each(["image", "file"])("waits for mixed attachment preparation when the %s finishes first", async (first) => {
    let reader!: FileReader;
    let finishUpload!: (value: Awaited<ReturnType<typeof uploadClientAttachments>>) => void;
    vi.mocked(uploadClientAttachments).mockReturnValueOnce(new Promise((resolve) => { finishUpload = resolve; }));
    const spy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { reader = this; });
    try {
      render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s",
        composer: { ...initialAppState.composer, draft: "Analyze both attachments" },
      }}><Composer /></AppStateProvider>);
      fireEvent.change(document.querySelector(".composer-file-input")!, { target: { files: [new File(["notes"], "notes.txt")] } });
      const image = new File(["image"], "chart.png", { type: "image/png" });
      fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => image }], getData: () => "" } });
      const uploaded = { id: "notes", name: "notes.txt", path: ".myharness/client-uploads/notes.txt", size: 5 };
      const finish = async (kind: string) => act(async () => {
        if (kind === "file") finishUpload({ attachments: [uploaded] });
        else {
          Object.defineProperty(reader, "result", { value: "data:image/png;base64,aW1hZ2U=" });
          reader.onload?.(new ProgressEvent("load") as ProgressEvent<FileReader>);
        }
      });
      await finish(first);
      fireEvent.submit(document.querySelector("form")!);
      expect(sendMessage).not.toHaveBeenCalled();
      await finish(first === "image" ? "file" : "image");
      await act(async () => fireEvent.submit(document.querySelector("form")!));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
        attachments: [expect.objectContaining({ name: "chart.png" })], attachmentRefs: [uploaded],
      }));
    } finally {
      spy.mockRestore();
    }
  });

  it("unblocks sending after a pasted image cannot be read", async () => {
    let reader!: FileReader;
    const spy = vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) { reader = this; });
    try {
      render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s",
        composer: { ...initialAppState.composer, draft: "Keep this text" },
      }}><Composer /></AppStateProvider>);
      const image = new File(["image"], "broken.png", { type: "image/png" });
      fireEvent.paste(screen.getByRole("textbox"), { clipboardData: { items: [{ kind: "file", type: "image/png", getAsFile: () => image }], getData: () => "" } });
      await act(async () => { reader.onerror?.(new ProgressEvent("error") as ProgressEvent<FileReader>); });
      await act(async () => fireEvent.submit(document.querySelector("form")!));
      expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ line: "Keep this text", attachments: [] }));
    } finally {
      spy.mockRestore();
    }
  });
  it.each([false, true])("ignores an old upload after changing sessions (failure=%s)", async (failure) => {
    let resolveUpload!: (value: Awaited<ReturnType<typeof uploadClientAttachments>>) => void;
    let rejectUpload!: (error: Error) => void;
    vi.mocked(uploadClientAttachments).mockReturnValueOnce(new Promise((resolve, reject) => { resolveUpload = resolve; rejectUpload = reject; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", clientId: "client-1" }}><Composer /><SwitchSessionProbe /><ModalHost /></AppStateProvider>);
    fireEvent.change(document.querySelector(".composer-file-input")!, { target: { files: [new File(["notes"], "old-upload.txt", { type: "text/plain" })] } });
    fireEvent.click(screen.getByText("Switch session"));
    await act(async () => {
      if (failure) rejectUpload(new Error("old upload failed"));
      else resolveUpload({ attachments: [{ id: "old", name: "old-upload.txt", path: "old-upload.txt", size: 5 }] });
    });
    expect(screen.queryByText("old-upload.txt")).toBeNull();
    expect(screen.queryByText("old upload failed")).toBeNull();
  });
  it.each([
    ["$national-assembly", 1, "$mcp:national-assembly", "click"],
    ["$national-assembly", 10, "$mcp:national-assembly", "Tab"],
    ["$future-connector", 8, "$mcp:future-connector", "Enter"],
    ["$design-review", 4, "$design-review", "click"],
    ["@outputs/report.md", 5, "@outputs/report.md", "Tab"],
    ["/help", 2, "/help", "Tab"],
  ])("recognizes and replaces the whole %s token at caret %s", async (token, caret, replacement, action) => {
    const suffix = " 포스코 관련 법안 찾아봐";
    render(<AppStateProvider initialState={{ ...initialAppState,
      composer: { ...initialAppState.composer, draft: `${token}${suffix}` },
      commands: [{ name: "help", description: "Help" }],
      skills: [
        { name: "design-review", description: "Design" },
        { name: "future-connector", description: "Future connector", source: "skill-mcp:future-connector" },
        { name: "unrelated", description: "Other" },
      ],
      mcpServers: [{ name: "national-assembly", state: "connected" }],
      artifacts: [{ path: "outputs/report.md", kind: "file" }],
    }}><Composer /></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(Number(caret), Number(caret));
    fireEvent.select(input);
    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    if (action === "click") await userEvent.click(options[0]);
    else fireEvent.keyDown(input, { key: action });
    expect(input.value).toBe(`${replacement}${suffix}`);
  });

  it("keeps an unknown mention unchanged without unrelated suggestions", () => {
    render(<AppStateProvider initialState={{ ...initialAppState,
      composer: { ...initialAppState.composer, draft: "$unknown-service 내용" },
      skills: [{ name: "design-review", description: "Design" }],
    }}><Composer /></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    input.focus();
    input.setSelectionRange(1, 1);
    fireEvent.select(input);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input.value).toBe("$unknown-service 내용");
  });

  it.each(["@", "$", "$mcp", "/"])("dismisses %s suggestions outside without changing the draft and reopens on typing", async (trigger) => {
    render(<AppStateProvider initialState={{ ...initialAppState,
      commands: [{ name: "entry", description: "Command" }],
      artifacts: [{ path: "entry.txt", kind: "file" }],
      skills: [{ name: "entry", description: "Skill" }],
      mcpServers: [{ name: "entry", state: "connected" }],
    }}><Composer /><button>Outside</button></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(input, trigger);
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await userEvent.click(input);
    fireEvent.pointerDown(screen.getByRole("listbox"));
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(input.value).toBe(trigger);
    await userEvent.type(input, trigger === "$mcp" ? ":e" : "e");
    expect(screen.getAllByRole("option").length).toBeGreaterThan(0);
    await userEvent.click(screen.getAllByRole("option")[0]);
    expect(input.value).toContain("entry");
  });

  it.each(["참고자료 연결", "Skill 및 MCP 호출"])("dismisses and reopens the %s button picker", async (label) => {
    render(<AppStateProvider initialState={{ ...initialAppState,
      artifacts: [{ path: "entry.txt", kind: "file" }],
      skills: [{ name: "entry", description: "Skill" }],
    }}><Composer /><button>Outside</button></AppStateProvider>);
    const picker = screen.getByRole("button", { name: label });
    await userEvent.click(picker);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Outside" }));
    expect(picker.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    await userEvent.click(picker);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.click(picker);
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it.each(["$mcp", "$mcp:", "$MCP"])("shows the full MCP catalog for %s and can select the last entry", async (query) => {
    render(<AppStateProvider initialState={{ ...initialAppState,
      mcpServers: Array.from({ length: 15 }, (_, i) => ({ name: `service-${i}`, state: "connected" })),
      skills: [
        ...Array.from({ length: 15 }, (_, i) => ({ name: `connector-${i}`, description: "External data", source: `skill-mcp:connector-${i}` })),
        { name: "mcp-guide", description: "Ordinary skill" },
      ],
    }}><Composer /></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(input, query);
    expect(screen.getAllByRole("option")).toHaveLength(30);
    await userEvent.keyboard("{ArrowUp}{Tab}");
    expect(input.value).toBe("$mcp:connector-14 ");
    await userEvent.clear(input);
    await userEvent.type(input, "$mcp:connector-14");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await userEvent.type(input, "-missing");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });

  it.each(["/", "@", "$"])("shows all matching %s suggestions beyond eight entries", async (trigger) => {
    render(<AppStateProvider initialState={{ ...initialAppState,
      commands: Array.from({ length: 20 }, (_, i) => ({ name: `entry-${i}`, description: "Command" })),
      artifacts: Array.from({ length: 20 }, (_, i) => ({ path: `entry-${i}`, kind: "file" })),
      skills: Array.from({ length: 20 }, (_, i) => ({ name: `entry-${i}`, description: "Skill" })),
    }}><Composer /></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(input, trigger);
    expect(screen.getAllByRole("option")).toHaveLength(20);
    await userEvent.click(screen.getByRole("option", { name: new RegExp("entry-19") }));
    expect(input.value.trim()).toBe(`${trigger}entry-19`);
  });

  it.each(["send", "steer", "cancel", "missing-session", "help"])("keeps another running session intact after a delayed %s result", async (operation) => {
    let resolve!: (value: { ok: boolean }) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<{ ok: boolean }>((res, rej) => { resolve = res; reject = rej; });
    if (operation === "cancel") vi.mocked(cancelMessage).mockReturnValueOnce(pending);
    else vi.mocked(sendMessage).mockReturnValueOnce(pending);
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-a", clientId: "client", busy: operation === "steer" || operation === "cancel" }}>
      <Composer /><SwitchSessionProbe />
    </AppStateProvider>);
    if (operation !== "cancel") fireEvent.change(screen.getByRole("textbox"), { target: { value: operation === "help" ? "/help" : "session A request" } });
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(operation === "cancel" ? cancelMessage : sendMessage).toHaveBeenCalled());
    fireEvent.click(screen.getByText("Switch session"));
    await act(async () => {
      if (operation === "cancel") resolve({ ok: true });
      else reject(new Error(operation === "missing-session" ? "Unknown session" : "session A failed"));
    });
    expect(screen.getByTestId("session-state").textContent).toBe("session-b:true");
    expect(startSession).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    vi.mocked(enhancePrompt).mockReset();
    vi.mocked(enhancePrompt).mockResolvedValue({ text: "개선한 요청" });
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

  it("sends analysis scope and answer length independently of output mode", async () => {
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c" }}><Composer /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "분석 범위" }));
    await userEvent.click(screen.getByRole("button", { name: /심층/ }));
    await userEvent.click(screen.getByRole("button", { name: "채팅 답변 분량" }));
    await userEvent.click(screen.getByRole("button", { name: "짧게" }));
    await userEvent.type(screen.getByRole("textbox"), "근거를 비교해줘");
    await userEvent.click(screen.getByRole("button", { name: "메시지 보내기" }));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ composeOptions: { analysis_depth: "deep", answer_length: "brief" } }));
  });

  it("improves only the draft and restores the original without sending a message", async () => {
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c" }}><Composer /></AppStateProvider>);
    await userEvent.type(screen.getByRole("textbox"), "원문 요청");
    await userEvent.click(screen.getByRole("button", { name: "요청 개선" }));
    await userEvent.click(screen.getByRole("button", { name: "요청 개선하기" }));
    await waitFor(() => expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("개선한 요청"));
    expect(sendMessage).not.toHaveBeenCalled();
    expect(enhancePrompt).toHaveBeenCalledWith(expect.objectContaining({ text: "원문 요청", options: ["structure", "evidence", "missing_context", "output_format"] }));
    await userEvent.click(screen.getByRole("button", { name: "개선 전 원문 복원" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("원문 요청");
  });

  it("does not overwrite typing that happens while improvement is in flight", async () => {
    let finish!: (value: { text: string }) => void;
    vi.mocked(enhancePrompt).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c" }}><Composer /></AppStateProvider>);
    await userEvent.type(screen.getByRole("textbox"), "원문");
    await userEvent.click(screen.getByRole("button", { name: "요청 개선" }));
    await userEvent.click(screen.getByRole("button", { name: "요청 개선하기" }));
    expect((screen.getByRole("button", { name: "메시지 보내기" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole("textbox"), " 추가");
    await act(async () => finish({ text: "늦은 결과" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("원문 추가");
    expect(screen.getByRole("alert").textContent).toContain("입력 내용이 변경되어");
  });

  it("keeps the original draft when improvement fails", async () => {
    vi.mocked(enhancePrompt).mockRejectedValueOnce(new Error("연결 실패"));
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c" }}><Composer /></AppStateProvider>);
    await userEvent.type(screen.getByRole("textbox"), "원문");
    await userEvent.click(screen.getByRole("button", { name: "요청 개선" }));
    await userEvent.click(screen.getByRole("button", { name: "요청 개선하기" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("연결 실패"));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("원문");
  });

  it("uses the runtime catalog for new model and effort choices below the pill", async () => {
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "s", clientId: "c", model: "model-old", runtimePicker: { ...initialAppState.runtimePicker, providers: [{ value: "future-provider", label: "Future provider" }], modelsByProvider: { "future-provider": [{ value: "model-new", label: "New model" }] }, models: [{ value: "model-new", label: "New model" }], efforts: [{ value: "high", label: "High" }] } }}><Composer /></AppStateProvider>);
    await userEvent.click(screen.getByRole("button", { name: "모델 선택" }));
    await userEvent.click(screen.getByRole("button", { name: "New model" }));
    expect(sendBackendRequest).toHaveBeenCalledWith("s", "c", { type: "apply_select_command", request_id: expect.any(String), command: "runtime_model", value: JSON.stringify({ profile: "future-provider", model: "model-new" }) });
    await userEvent.click(screen.getByRole("button", { name: "추론 노력도" }));
    await userEvent.click(screen.getByRole("button", { name: "High" }));
    expect(sendBackendRequest).toHaveBeenCalledWith("s", "c", { type: "apply_select_command", request_id: expect.any(String), command: "effort", value: "high" });
  });

  it("toggles reference pickers without changing the draft and inserts only a selected item", async () => {
    render(<AppStateProvider initialState={{ ...initialAppState,
      skills: [{ name: "new-skill", description: "새 스킬", enabled: true }],
      artifacts: [{ path: "outputs/new-file.md", name: "new-file.md", kind: "file" }],
    }}><Composer /></AppStateProvider>);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    await userEvent.type(input, "비교해줘");
    for (const name of ["참고자료 연결", "Skill 및 MCP 호출"]) {
      const button = screen.getByRole("button", { name });
      await userEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(input.value).toBe("비교해줘");
      await userEvent.click(button);
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(document.querySelector("#slashMenu")?.classList.contains("hidden")).toBe(true);
      expect(input.value).toBe("비교해줘");
    }
    await userEvent.click(screen.getByRole("button", { name: "참고자료 연결" }));
    await userEvent.click(screen.getByRole("button", { name: "Skill 및 MCP 호출" }));
    await userEvent.click(screen.getByRole("option", { name: /new-skill/ }));
    expect(input.value).toBe("비교해줘 $new-skill ");
    await userEvent.clear(input);
    await userEvent.type(input, "@new");
    await userEvent.click(screen.getByRole("button", { name: "참고자료 연결" }));
    expect(input.value).toBe("@new");
    expect(document.querySelector("#slashMenu")?.classList.contains("hidden")).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "참고자료 연결" }));
    await userEvent.keyboard("{Escape}");
    expect(document.querySelector("#slashMenu")?.classList.contains("hidden")).toBe(true);
  });

  it("uses the shared Lumina blue palette for the send button", () => {
    const stylesheet = readStylesheet();

    expect(stylesheet).toContain("--brand-accent: var(--color-cobalt);");
    expect(stylesheet).toContain("--send-button-bg: var(--brand-accent);");
    expect(stylesheet).toContain("--send-button-ink: var(--color-white);");
  });

  it("does not expose an image file attachment button", () => {
    render(
      <AppStateProvider>
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.queryByRole("button", { name: "이미지 첨부" })).toBeNull();
  });

  it("keeps text and send inside the pill and supporting tools below", async () => {
    render(<AppStateProvider><Composer /></AppStateProvider>);
    const pill = document.querySelector(".composer-box")!;
    expect(pill.children).toHaveLength(2);
    expect(pill.firstElementChild?.tagName).toBe("TEXTAREA");
    expect(document.querySelector("#sendButton")?.closest(".composer-box")).toBe(pill);
    expect(pill.querySelectorAll("button")).toHaveLength(1);
    expect(document.querySelector(".composer-toolbar [title]")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
    expect(screen.getByRole("dialog", { name: "출력 방식 및 파일 분량" })).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps the send payload unchanged when the panel is opened but not edited", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

  it("preserves output options when the popover is closed", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{ ...initialAppState, sessionId: "session-1", clientId: "client-1" }}>
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
    await user.click(screen.getByRole("button", { name: "파일" }));
    await user.click(screen.getByRole("button", { name: "수정" }));
    await user.click(screen.getByRole("button", { name: "16k" }));
    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "접은 뒤에는 자동으로 보내줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      composeOptions: expect.objectContaining({ output_surface: "artifact", artifact_action: "edit", target_output_tokens: 16000 }),
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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

    await user.click(screen.getByRole("button", { name: "출력 방식 및 파일 분량" }));
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
    await waitFor(() => {
      expect(input.value).toBe(expectedPrompt);
      expect(document.activeElement).toBe(input);
    });
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
        <AttachmentEchoProbe />
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

    expect(screen.getByRole("button", { name: "quarter-plan.png 이미지 크게 보기" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Replay attachment echo" }));
    expect(screen.getAllByRole("button", { name: "quarter-plan.png 이미지 크게 보기" })).toHaveLength(1);
    expect(screen.queryByText("[quarter-plan.png]")).toBeNull();
    expect(screen.queryByText("[image attachments: 1]")).toBeNull();
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
    expect(screen.queryByText("플러그인")).toBeNull();
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

  it("shows enabled and disabled skills in dollar search and selects a disabled skill", async () => {
    const user = userEvent.setup();
    const skills = Array.from({ length: 10 }, (_, index) => ({
      name: `skill-${index + 1}`,
      description: `Skill ${index + 1}`,
      enabled: index % 2 === 0,
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
    await user.type(input, "skill-10");
    expect(screen.getAllByRole("option")).toHaveLength(1);
    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", "$skill-10 ");
  });

  it("searches disabled skills by description and quotes names containing spaces", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider initialState={{
        ...initialAppState,
        skills: [{ name: "검토 스킬", description: "문서 점검", enabled: false }],
      }}>
        <Composer />
      </AppStateProvider>,
    );
    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "이 문서를 $점검");
    await user.keyboard("{Enter}");
    expect(input).toHaveProperty("value", '이 문서를 $"검토 스킬" ');
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
            { name: "browser-qa", description: "브라우저 MCP 라우팅", source: "skill-mcp:browser", enabled: false },
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

  it("shows a skill-mcp wrapper when its configured server is not auto-connected", async () => {
    const user = userEvent.setup();

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          mcpServers: [
            { name: "posco-erp", state: "disabled", transport: "stdio" },
          ],
          skills: [
            {
              name: "posco-erp",
              description: "POSCO ERP 연결형 MCP 라우팅",
              source: "skill-mcp:posco-erp",
              enabled: true,
            },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("메시지를 입력하세요...");
    await user.type(input, "$mcp:posco");

    expect(screen.getAllByRole("option", { name: /\$mcp:posco-erp/ })).toHaveLength(1);
    expect(screen.getByRole("option", { name: /\$mcp:posco-erp/ }).textContent).toContain("연결형 MCP 라우팅");
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
    await waitFor(() => expect(input.selectionStart).toBe("이 파일 참고 @outputs/report.md ".length));
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

    await waitFor(() => expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      cwd: "C:/demo",
      activeProfile: "p-gpt",
      model: "gpt-5.4",
      effort: "high",
    })));
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-new",
      line: "새 질문",
    }));
  });

  it("keeps a fresh chat busy while its first response is waiting for stream events", async () => {
    const user = userEvent.setup();
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
        <BusyProbe />
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "첫 질문");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "session-new",
      line: "첫 질문",
    })));
    expect(screen.getByTestId("busy-state").textContent).toBe("true");
  });

  it.each([false, true])("restores conversation atomically on expired backend (preview: %s)", async (historyReadOnly) => {
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("Unknown session")).mockResolvedValueOnce({ ok: true });
    vi.mocked(startSession).mockResolvedValueOnce({ sessionId: "session-recovered" });
    render(<AppStateProvider initialState={{ ...initialAppState, sessionId: "session-expired", clientId: "client-1", activeHistoryId: "saved-conversation", historyReadOnly, composer: { ...initialAppState.composer, draft: "앞에서 정한 기준으로 계속해줘" } }}><Composer /></AppStateProvider>);
    fireEvent.submit(document.querySelector("form")!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "session-recovered", resumeSessionId: "saved-conversation",
      line: "앞에서 정한 기준으로 계속해줘",
    }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("recreates an expired backend session and retries the message once", async () => {
    const user = userEvent.setup();
    vi.mocked(sendMessage)
      .mockRejectedValueOnce(new Error("Unknown session"))
      .mockResolvedValueOnce({ ok: true });
    vi.mocked(startSession).mockResolvedValueOnce({ sessionId: "session-recovered" });

    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-expired",
          clientId: "client-1",
          workspacePath: "C:/demo",
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "세션 복구 질문");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    await waitFor(() => expect(startSession).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "client-1",
      cwd: "C:/demo",
    })));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "session-recovered",
      line: "세션 복구 질문",
    }));
  });

  it("resumes a previewed saved session before sending its follow-up", async () => {
    const user = userEvent.setup();
    render(
      <AppStateProvider
        initialState={{
          ...initialAppState,
          sessionId: "session-live",
          clientId: "client-1",
          activeHistoryId: "session-saved",
          historyReadOnly: true,
          messages: [
            { id: "question", role: "user", text: "저장된 질문" },
            { id: "answer", role: "assistant", text: "저장된 답변", isComplete: true },
          ],
        }}
      >
        <Composer />
      </AppStateProvider>,
    );

    await user.type(screen.getByPlaceholderText("메시지를 입력하세요..."), "이어서 설명해줘");
    await user.click(screen.getByRole("button", { name: "메시지 보내기" }));

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "session-live", resumeSessionId: "session-saved", line: "이어서 설명해줘",
    }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
  });

  it("reconnects in the previewed workspace and preserves uploaded file references", async () => {
    const uploaded = { id: "source", name: "source.txt", path: ".myharness/client-uploads/source.txt", size: 10 };
    vi.mocked(uploadClientAttachments).mockResolvedValueOnce({ attachments: [uploaded] });
    vi.mocked(sendMessage).mockRejectedValueOnce(new Error("Unknown session"));
    vi.mocked(startSession).mockResolvedValueOnce({ sessionId: "selected-backend", workspace: { name: "Selected", path: "C:/selected" } });
    render(<AppStateProvider initialState={{
      ...initialAppState, sessionId: "previous-backend", clientId: "client-1",
      activeHistoryId: "selected-history", historyReadOnly: true,
      workspaceName: "Selected", workspacePath: "C:/selected",
      composer: { ...initialAppState.composer, draft: "Continue with this source" },
    }}><Composer /></AppStateProvider>);
    fireEvent.change(document.querySelector(".composer-file-input")!, { target: { files: [new File(["content"], "source.txt")] } });
    await screen.findByText("source.txt");
    await act(async () => fireEvent.submit(document.querySelector("form")!));
    expect(uploadClientAttachments).toHaveBeenCalledWith(expect.objectContaining({ workspacePath: "C:/selected" }));
    expect(sendMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: "previous-backend", workspacePath: "C:/selected" }));
    expect(startSession).toHaveBeenCalledWith(expect.objectContaining({ cwd: "C:/selected" }));
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "selected-backend", workspacePath: "C:/selected", resumeSessionId: "selected-history", attachmentRefs: [uploaded],
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

    expect(screen.getByRole<HTMLButtonElement>("button", { name: "메시지 보내기" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "작업 중단" })).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      line: "/plan",
      suppressUserTranscript: true,
    }));

    fireEvent.change(input, { target: { value: "전환 중 새로 입력한 문장" } });
    await act(async () => {
      resolvePlan({ ok: true });
    });
    expect((input as HTMLTextAreaElement).value).toBe("전환 중 새로 입력한 문장");
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
    expect(stop.querySelector("rect")?.getAttribute("width")).toBe("16");
    expect(stop.querySelector("circle")).toBeNull();

    await userEvent.click(stop);

    expect(cancelMessage).toHaveBeenCalledWith("session-1", "client-1");
  });

  it("shows the collapsed todo icon immediately before the send button inside the input", async () => {
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
    expect(todoButton.parentElement?.classList.contains("composer-box")).toBe(true);
    expect(todoButton.nextElementSibling?.id).toBe("sendButton");
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
    expect(screen.queryByText("unemployment_industries 테이블 범위를 확인했습니다.")).toBeNull();
    expect(screen.getByText("분석 결과를 보고서 구조로 정리하고 있습니다.")).toBeTruthy();
  });

  it("shows only the current live workflow activity without an order label", () => {
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
    expect(activity.textContent || "").not.toContain("공식 발표 자료 3건을 확인했습니다.");
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
          statusText: "준비됨",
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

  it("renders backend questions inside chat instead of above the composer input", async () => {
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
        <MessageList />
        <Composer />
        <ModalHost />
      </AppStateProvider>,
    );

    const card = document.querySelector(".inline-question-card");
    const composerBox = document.querySelector(".composer-box");
    expect(card).toBeTruthy();
    expect(document.querySelector(".messages")?.contains(card)).toBe(true);
    expect(document.querySelector(".composer")?.contains(card)).toBe(false);
    expect(Boolean(card && composerBox && (card.compareDocumentPosition(composerBox) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
    expect(screen.queryByRole("dialog", { name: "질문" })).toBeNull();
    expect(screen.getByText("Q1")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /파랑/ }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "선택한 답변 보내기" }));

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
        <MessageList />
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
          <MessageList />
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
        <MessageList />
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
        <MessageList />
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
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.getByText("질문 (1/3)")).toBeTruthy();
    expect(screen.getByText("피해금액은 얼마인가요?")).toBeTruthy();
    expect(screen.queryByText("송금한 날짜와 시간은 언제인가요?")).toBeNull();
    expect(screen.queryByPlaceholderText("답변 입력...")).toBeNull();
    expect(screen.getByPlaceholderText("기타 직접 입력...")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /정보가 아직 부족함/ }));
    await user.click(screen.getByRole("button", { name: "선택한 답변 보내기" }));
    expect(sendBackendRequest).not.toHaveBeenCalled();
    expect(screen.getByText("질문 (2/3)")).toBeTruthy();
    expect(screen.getByText("송금한 날짜와 시간은 언제인가요?")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: /직접 입력 양식/ }));
    await user.click(screen.getByRole("button", { name: "선택한 답변 보내기" }));
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
        <MessageList />
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
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    expect(screen.getByPlaceholderText("답변 입력...")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /A1\s*친근한 톤 \+ 짧은 선택형/ })).toBeNull();

    await user.type(screen.getByPlaceholderText("답변 입력..."), "친근하게");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(screen.queryByPlaceholderText("답변 입력...")).toBeNull();
    await user.click(screen.getByRole("button", { name: /A1\s*친근한 톤 \+ 짧은 선택형/ }));
    await user.click(screen.getByRole("button", { name: "선택한 답변 보내기" }));

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
        <MessageList />
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
        <MessageList />
        <Composer />
      </AppStateProvider>,
    );

    const input = screen.getByPlaceholderText("답변 입력...");
    expect(input).toBeTruthy();

    await user.type(input, "주관식 입력칸 유지");
    await user.click(screen.getByRole("button", { name: "답변" }));
    expect(screen.getByText("질문 (2/2)")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: /불릿 목록 답변/ }));
    await user.click(screen.getByRole("button", { name: "선택한 답변 보내기" }));

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
        <MessageList />
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
