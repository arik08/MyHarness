import { describe, expect, it, vi } from "vitest";
import { appReducer, initialAppState, loadHiddenHistoryKeys } from "../reducer";
import { historyVisibilityKey } from "../../utils/history";

vi.stubGlobal("crypto", { randomUUID: () => "message-1" });

describe("appReducer", () => {
  it("uses browser download as the default file save mode", () => {
    expect(initialAppState.appSettings.downloadMode).toBe("browser");
  });

  it("keeps all supported file save modes when settings change", () => {
    const browser = appReducer(initialAppState, {
      type: "set_app_settings",
      value: { downloadMode: "browser" },
    });
    const ask = appReducer(initialAppState, {
      type: "set_app_settings",
      value: { downloadMode: "ask" },
    });
    const folder = appReducer(initialAppState, {
      type: "set_app_settings",
      value: { downloadMode: "folder" },
    });

    expect(browser.appSettings.downloadMode).toBe("browser");
    expect(ask.appSettings.downloadMode).toBe("ask");
    expect(folder.appSettings.downloadMode).toBe("folder");
  });

  it("hides history rows in normal mode and persists the hidden key", () => {
    localStorage.removeItem("myharness:hiddenHistoryKeys");
    const historyItem = {
      value: "session-hidden",
      label: "5/3 10:00 2 msg",
      description: "숨길 대화",
      workspace: { name: "Default", path: "C:/demo" },
    };
    const key = historyVisibilityKey("session-hidden", "C:/demo", "Default");
    const hidden = appReducer(
      {
        ...initialAppState,
        workspaceName: "Default",
        workspacePath: "C:/demo",
        history: [historyItem],
      },
      { type: "hide_history_local", sessionId: "session-hidden", workspacePath: "C:/demo", workspaceName: "Default" },
    );
    const refreshed = appReducer(hidden, { type: "set_history", history: [historyItem] });

    expect(hidden.hiddenHistoryKeys).toContain(key);
    expect(loadHiddenHistoryKeys()).toContain(key);
    expect(refreshed.history).toEqual([]);
  });

  it("shows hidden history rows in admin mode and filters them again when admin mode turns off", () => {
    const historyItem = {
      value: "session-hidden",
      label: "5/3 10:00 2 msg",
      description: "숨긴 대화",
      workspace: { name: "Default", path: "C:/demo" },
    };
    const hiddenHistoryKeys = [historyVisibilityKey("session-hidden", "C:/demo", "Default")];
    const normal = {
      ...initialAppState,
      workspaceName: "Default",
      workspacePath: "C:/demo",
      hiddenHistoryKeys,
    };
    const filtered = appReducer(normal, { type: "set_history", history: [historyItem] });
    const admin = appReducer({ ...filtered, adminMode: true }, { type: "set_history", history: [historyItem] });
    const lockedAgain = appReducer(admin, { type: "set_admin_mode", value: false });

    expect(filtered.history).toEqual([]);
    expect(admin.history.map((item) => item.value)).toEqual(["session-hidden"]);
    expect(lockedAgain.history).toEqual([]);
  });

  it("applies ready snapshots", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "ready",
        state: {
          provider: "codex",
          provider_label: "Codex",
          model: "gpt-5",
          effort: "medium",
          permission_mode: "full_auto",
          workspace: {
            name: "Default",
            path: "C:/demo",
            scope: { mode: "shared", name: "shared", root: "C:/root" },
          },
        },
      },
    });

    expect(next.ready).toBe(true);
    expect(next.statusText).toBe("준비됨");
    expect(next.workspaceName).toBe("Default");
  });

  it("applies optimistic permission mode updates", () => {
    const next = appReducer(initialAppState, { type: "set_permission_mode", value: "plan" });

    expect(next.permissionMode).toBe("plan");
  });

  it("stores swarm status snapshots from backend events", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "swarm_status",
        swarm_teammates: [
          {
            id: "research@office",
            name: "research",
            role: "조사",
            status: "running",
            task: "계약서 조항 확인",
            startedAt: 1710000000000,
            lastOutput: "제3조 검토 중",
            taskId: "a123",
          },
        ],
        swarm_notifications: [
          {
            id: "n1",
            from: "검토",
            message: "위험 조항 1건 발견",
            timestamp: 1710000001000,
            level: "warning",
          },
        ],
      },
    });

    expect(next.swarmTeammates).toHaveLength(1);
    expect(next.swarmTeammates[0].role).toBe("조사");
    expect(next.swarmNotifications).toHaveLength(1);
    expect(next.swarmNotifications[0].level).toBe("warning");
  });

  it("closes the swarm popup when the backend session changes", () => {
    const next = appReducer(
      {
        ...initialAppState,
        swarmPopupOpen: true,
      },
      { type: "session_started", sessionId: "session-2" },
    );

    expect(next.swarmPopupOpen).toBe(false);
  });

  it("appends assistant deltas to the active assistant message", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "안녕" },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "하세요" },
    });

    expect(second.messages).toHaveLength(1);
    expect(second.messages[0].text).toBe("안녕하세요");
  });

  it("shows answer drafting progress while assistant text streams", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "HTML 작성 중" },
    });

    const answerEvent = next.workflowEvents.find((event) => event.role === "final");
    expect(next.busy).toBe(true);
    expect(answerEvent?.title).toBe("응답 작성");
    expect(answerEvent?.status).toBe("running");
    expect(answerEvent?.detail).toContain("수신 중");
  });

  it("updates status text without adding progress rows to the transcript", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "status", message: "맥락을 확인하고 있습니다." },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: { type: "status", message: "관련 파일을 읽고 있습니다." },
    });

    expect(second.statusText).toBe("관련 파일을 읽고 있습니다.");
    expect(second.messages).toHaveLength(0);
  });

  it("keeps repeated status progress out of the transcript", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "status", message: "관련 파일을 읽고 있습니다." },
    });
    const duplicate = appReducer(first, {
      type: "backend_event",
      event: { type: "status", message: "관련 파일을 읽고 있습니다." },
    });

    expect(duplicate.statusText).toBe("관련 파일을 읽고 있습니다.");
    expect(duplicate.messages).toHaveLength(0);
  });

  it("updates status text without adding transcript rows for quiet status heartbeats", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "status", message: "AI 자동편집 대기 중 · 45초 경과", quiet: true },
    });

    expect(next.statusText).toBe("AI 자동편집 대기 중 · 45초 경과");
    expect(next.messages).toHaveLength(0);
  });

  it("rebuilds a live streaming answer and workflow from replayed snapshot events", () => {
    const cleared = appReducer(
      {
        ...initialAppState,
        messages: [{ id: "old", role: "assistant", text: "다른 세션 화면" }],
      },
      { type: "backend_event", event: { type: "clear_transcript" } as any },
    );
    const withUser = appReducer(cleared, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "실시간 파일 작성해줘" } },
    });
    const withPreview = appReducer(withUser, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"hello",
      },
    });
    const streaming = appReducer(withPreview, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "진행 중인 답변" },
    });

    expect(streaming.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "실시간 파일 작성해줘"],
      ["assistant", "진행 중인 답변"],
    ]);
    expect(streaming.workflowAnchorMessageId).toBe(streaming.messages[0].id);
    expect(streaming.workflowEvents.find((event) => event.toolName === "write_file")?.status).toBe("running");
    expect(streaming.busy).toBe(true);
    expect(streaming.status).toBe("processing");
  });

  it("accepts legacy assistant delta value payloads", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_delta", value: "fallback" },
    });

    expect(next.messages[0].text).toBe("fallback");
  });

  it("uses assistant completion text as the final answer", () => {
    const streaming = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "임시" },
    });
    const completed = appReducer(streaming, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "최종 답변" },
    });

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0].text).toBe("최종 답변");
    expect(completed.messages[0].isComplete).toBe(true);
    expect(completed.busy).toBe(false);
  });

  it("shows assistant completion even when no delta streamed first", () => {
    const completed = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "AI 팀 작업자가 아직 진행 중입니다." },
    });

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0].text).toBe("AI 팀 작업자가 아직 진행 중입니다.");
    expect(completed.messages[0].isComplete).toBe(true);
    expect(completed.busy).toBe(false);
  });

  it("does not shrink streamed assistant text when completion only repeats the tail", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "공개적으로 확인 가능한 자료를 기준으로 작성하겠습니다.\n\n" },
    });
    const streaming = appReducer(first, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "OpenAI 공식 페이지 일부가 403으로 막혀 우회/대체 출처를 병행해." },
    });
    const completed = appReducer(streaming, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "OpenAI 공식 페이지 일부가 403으로 막혀 우회/대체 출처를 병행해." },
    });

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0].text).toBe(
      "공개적으로 확인 가능한 자료를 기준으로 작성하겠습니다.\n\nOpenAI 공식 페이지 일부가 403으로 막혀 우회/대체 출처를 병행해.",
    );
    expect(completed.messages[0].isComplete).toBe(true);
  });

  it("moves tool-use assistant completions into workflow progress", () => {
    const completed = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "도구 호출 준비", has_tool_uses: true },
    });

    expect(completed.messages).toHaveLength(0);
    expect(completed.workflowEvents.find((event) => event.role === "planning")?.detail).toBe("도구 호출 준비");
    expect(completed.busy).toBe(true);
  });

  it("starts a fresh assistant message when final answer streams after a tool-use handoff", () => {
    const handoff = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "도구 호출 준비", has_tool_uses: true },
    });
    const streaming = appReducer(handoff, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "최종 답변" },
    });

    expect(streaming.messages.map((message) => [message.role, message.text, message.isComplete])).toEqual([
      ["assistant", "최종 답변", undefined],
    ]);
  });

  it("keeps streamed tool-use handoff text visible in the chat body", () => {
    const withUser = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "올해 철강 경쟁사 이슈 정리" } },
    });
    const streaming = appReducer(withUser, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "해외 경쟁사는 생산량과 저탄소 전환 기준으로 보겠습니다." },
    });
    const handoff = appReducer(streaming, {
      type: "backend_event",
      event: {
        type: "assistant_complete",
        message: "해외 경쟁사는 생산량과 저탄소 전환 기준으로 보겠습니다.",
        has_tool_uses: true,
      },
    });

    expect(handoff.messages.map((message) => [message.role, message.text, message.isComplete])).toEqual([
      ["user", "올해 철강 경쟁사 이슈 정리", undefined],
      ["assistant", "해외 경쟁사는 생산량과 저탄소 전환 기준으로 보겠습니다.", true],
    ]);
    expect(handoff.workflowEvents.find((event) => event.role === "planning")?.detail).toBe(
      "해외 경쟁사는 생산량과 저탄소 전환 기준으로 보겠습니다.",
    );
  });

  it("starts a fresh assistant message when a new answer streams after a completed answer", () => {
    const completed = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "이전 답변" },
    });
    const streaming = appReducer(completed, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "새 답변" },
    });

    expect(streaming.messages.map((message) => [message.role, message.text, message.isComplete])).toEqual([
      ["assistant", "이전 답변", true],
      ["assistant", "새 답변", undefined],
    ]);
  });

  it("treats replayed assistant transcript items as complete before later deltas arrive", () => {
    const replayed = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "assistant", text: "리플레이된 답변" } },
    });
    const streaming = appReducer(replayed, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "새 스트리밍" },
    });

    expect(streaming.messages.map((message) => [message.role, message.text, message.isComplete])).toEqual([
      ["assistant", "리플레이된 답변", true],
      ["assistant", "새 스트리밍", undefined],
    ]);
  });

  it("ignores duplicate regular backend user transcript because the composer already rendered it", () => {
    const withOptimisticUser = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "안녕?" },
    });
    const optimistic = appReducer(withOptimisticUser, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "안녕?" } },
    });

    expect(optimistic.messages).toHaveLength(1);
    expect(optimistic.messages[0].text).toBe("안녕?");
  });

  it("ignores normalized duplicate long pasted user transcripts after replay progress", () => {
    const pastedText = Array.from({ length: 21 }, (_, index) => `붙여넣은 내용 ${index + 1}`).join("\r\n");
    const optimisticText = `요약해줘\n\n[붙여넣은 텍스트 1]\n${pastedText}\n`;
    const replayText = optimisticText.trim();
    const withOptimisticUser = appReducer({ ...initialAppState, sessionId: "session-live" }, {
      type: "append_message",
      message: { role: "user", text: optimisticText },
    });
    const busy = appReducer(withOptimisticUser, { type: "set_busy", value: true });
    const afterReplayClear = appReducer(busy, {
      type: "backend_event",
      event: { type: "clear_transcript" } as any,
    });
    const withWorkflowProgress = appReducer(afterReplayClear, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "shell_command",
        tool_input: { command: "echo progress" },
      },
    });
    const afterReplayUser = appReducer(withWorkflowProgress, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: replayText } },
    });

    expect(afterReplayUser.messages.filter((message) => message.role === "user")).toHaveLength(1);
    expect(afterReplayUser.messages[0].text).toBe(optimisticText);
    expect(afterReplayUser.workflowAnchorMessageId).toBe(afterReplayClear.workflowAnchorMessageId);
  });

  it("keeps distinct long user transcripts when replay text changes after normalization", () => {
    const pastedText = Array.from({ length: 21 }, (_, index) => `붙여넣은 내용 ${index + 1}`).join("\n");
    const firstText = `요약해줘\n\n[붙여넣은 텍스트 1]\n${pastedText}\n`;
    const withOptimisticUser = appReducer({ ...initialAppState, sessionId: "session-live" }, {
      type: "append_message",
      message: { role: "user", text: firstText },
    });
    const busy = appReducer(withOptimisticUser, { type: "set_busy", value: true });
    const next = appReducer(busy, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: `${firstText.trim()} 추가 요청` } },
    });

    expect(next.messages.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("ignores delayed duplicate regular user transcripts after an assistant tool-use handoff", () => {
    const withOptimisticUser = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "랜딩 페이지에 작업 가능한 샘플 프롬프트 제안 필요" },
    });
    const withToolUseHandoff = appReducer(withOptimisticUser, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "도구 호출 준비", has_tool_uses: true },
    });
    const withWorkflow = appReducer(withToolUseHandoff, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "skill", tool_input: { name: "using-superpowers" } },
    });
    const next = appReducer(withWorkflow, {
      type: "backend_event",
      event: {
        type: "transcript_item",
        item: { role: "user", text: "랜딩 페이지에 작업 가능한 샘플 프롬프트 제안 필요" },
      },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].text).toBe("랜딩 페이지에 작업 가능한 샘플 프롬프트 제안 필요");
  });

  it("restores regular backend user transcript when reconnecting to a live answer", () => {
    const reconnected = appReducer(
      { ...initialAppState, sessionId: "session-live", busy: true },
      {
        type: "backend_event",
        event: { type: "transcript_item", item: { role: "user", text: "진행 중 재접속 질문" } },
      },
    );

    expect(reconnected.messages).toHaveLength(1);
    expect(reconnected.messages[0]).toMatchObject({
      role: "user",
      text: "진행 중 재접속 질문",
    });
  });

  it("renders local composer user messages", () => {
    const next = appReducer({ ...initialAppState, sessionId: "session-live" }, {
      type: "append_message",
      message: { role: "user", text: "안녕?" },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].role).toBe("user");
    expect(next.messages[0].text).toBe("안녕?");
  });

  it("keeps the optimistic user turn visible when a reconnect replay clears the transcript", () => {
    const withOptimisticUser = appReducer({ ...initialAppState, sessionId: "session-live" }, {
      type: "append_message",
      message: { role: "user", text: "바로 보여야 하는 질문" },
    });
    const busy = appReducer(withOptimisticUser, { type: "set_busy", value: true });
    const afterReplayClear = appReducer(busy, {
      type: "backend_event",
      event: { type: "clear_transcript" } as any,
    });
    const afterReplayUser = appReducer(afterReplayClear, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "바로 보여야 하는 질문" } },
    });

    expect(afterReplayClear.messages).toHaveLength(1);
    expect(afterReplayClear.messages[0].text).toBe("바로 보여야 하는 질문");
    expect(afterReplayUser.messages).toHaveLength(1);
  });

  it("still clears immediately for the explicit clear command", () => {
    const withClearCommand = appReducer({ ...initialAppState, sessionId: "session-live" }, {
      type: "append_message",
      message: { role: "user", text: "/clear" },
    });
    const busy = appReducer(withClearCommand, { type: "set_busy", value: true });
    const cleared = appReducer(busy, {
      type: "backend_event",
      event: { type: "clear_transcript" } as any,
    });

    expect(cleared.messages).toHaveLength(0);
  });

  it("shows a new live chat in history as soon as the user sends a message", () => {
    const next = appReducer({ ...initialAppState, sessionId: "session-live", chatTitle: "MyHarness" }, {
      type: "append_message",
      message: { role: "user", text: "왼쪽 history 갱신 테스트" },
    });

    expect(next.history[0]).toMatchObject({
      value: "session-live",
      label: "진행 중인 채팅",
      description: "왼쪽 history 갱신 테스트",
    });
  });

  it("removes stale live history rows for the backend session that becomes active", () => {
    const next = appReducer(
      {
        ...initialAppState,
        sessionId: "old-session",
        history: [
          {
            value: "web-current",
            label: "진행 중인 채팅",
            description: "열려 있는 세션",
            live: true,
            liveSessionId: "web-current",
            busy: false,
          },
          {
            value: "saved-old",
            label: "5/3 10:00 2 msg",
            description: "저장된 대화",
          },
        ],
      },
      {
        type: "session_started",
        sessionId: "web-current",
        clientId: "client-1",
      },
    );

    expect(next.history.map((item) => item.value)).toEqual(["saved-old"]);
  });

  it("keeps a saved history row when its live backend session becomes active", () => {
    const next = appReducer(
      {
        ...initialAppState,
        sessionId: "old-session",
        history: [
          {
            value: "saved-live",
            label: "5/3 10:00 2 msg",
            description: "저장된 live 대화",
            live: true,
            liveSessionId: "web-live",
            busy: false,
          },
          {
            value: "web-live",
            label: "진행 중인 채팅",
            description: "열려 있는 세션",
            live: true,
            liveSessionId: "web-live",
            busy: false,
          },
        ],
      },
      {
        type: "session_started",
        sessionId: "web-live",
        clientId: "client-1",
      },
    );

    expect(next.history.map((item) => item.value)).toEqual(["saved-live"]);
  });

  it("hides the active backend question when switching to another live session", () => {
    const withQuestion = appReducer(
      { ...initialAppState, sessionId: "session-a" },
      {
        type: "backend_event",
        event: {
          type: "modal_request",
          modal: { kind: "question", request_id: "question-a", question: "A 세션 질문" },
        },
      },
    );

    const switched = appReducer(withQuestion, {
      type: "session_started",
      sessionId: "session-b",
      clientId: "client-1",
    });

    expect(switched.modal).toBeNull();
  });

  it("restores each live session's pending backend question when switching back", () => {
    const sessionAQuestion = appReducer(
      { ...initialAppState, sessionId: "session-a" },
      {
        type: "backend_event",
        event: {
          type: "modal_request",
          modal: { kind: "question", request_id: "question-a", question: "A 세션 질문" },
        },
      },
    );
    const sessionB = appReducer(sessionAQuestion, {
      type: "session_started",
      sessionId: "session-b",
      clientId: "client-1",
    });
    const sessionBQuestion = appReducer(sessionB, {
      type: "backend_event",
      event: {
        type: "modal_request",
        modal: { kind: "question", request_id: "question-b", question: "B 세션 질문" },
      },
    });

    const restoredSessionA = appReducer(sessionBQuestion, {
      type: "session_started",
      sessionId: "session-a",
      clientId: "client-1",
    });

    expect(restoredSessionA.modal).toEqual({
      kind: "backend",
      payload: { kind: "question", request_id: "question-a", question: "A 세션 질문" },
    });
  });

  it("restores pending backend questions after returning through a saved history id alias", () => {
    const withQuestion = appReducer(
      { ...initialAppState, sessionId: "live-a", activeHistoryId: "saved-a" },
      {
        type: "backend_event",
        event: {
          type: "modal_request",
          modal: { kind: "question", request_id: "question-a", question: "저장된 A 질문" },
        },
      },
    );
    const switchedAway = appReducer(withQuestion, {
      type: "begin_history_restore",
      sessionId: "saved-b",
    });
    const sessionB = appReducer(switchedAway, {
      type: "session_started",
      sessionId: "live-b",
      clientId: "client-1",
    });

    const restoringA = appReducer(sessionB, {
      type: "begin_history_restore",
      sessionId: "saved-a",
    });
    const restored = appReducer(restoringA, {
      type: "session_started",
      sessionId: "live-a",
      clientId: "client-1",
    });

    expect(restored.modal).toEqual({
      kind: "backend",
      payload: { kind: "question", request_id: "question-a", question: "저장된 A 질문" },
    });
  });

  it("keeps backend resume selection requests in the sidebar instead of opening a modal", () => {
    const next = appReducer(
      { ...initialAppState, sessionId: "session-current" },
      {
        type: "backend_event",
        event: {
          type: "select_request",
          modal: { command: "resume" },
          select_options: [
            { value: "saved-a", label: "05/05 04:12 6msg", description: "역질문 테스트" },
            { value: "saved-b", label: "05/05 03:28 6msg", description: "$dispatching-parallel-agents 설명" },
          ],
        },
      },
    );

    expect(next.modal).toBeNull();
    expect(next.history).toEqual([
      { value: "saved-a", label: "05/05 04:12 6msg", description: "역질문 테스트" },
      { value: "saved-b", label: "05/05 03:28 6msg", description: "$dispatching-parallel-agents 설명" },
    ]);
  });

  it("uses the active profile id to select runtime picker models for client sessions", () => {
    const ready = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "ready",
        state: {
          provider: "openai_codex",
          active_profile: "codex",
          provider_label: "Codex Subscription",
          model: "gpt-5.5",
        },
      },
    });
    const opened = appReducer(ready, { type: "open_runtime_picker" });
    const next = appReducer(opened, {
      type: "backend_event",
      event: {
        type: "select_request",
        modal: {
          command: "runtime-picker",
          runtime_options: {
            providers: [
              { value: "codex", label: "Codex Subscription", active: false },
            ],
            models_by_provider: {
              codex: [
                { value: "gpt-5.5", label: "gpt-5.5" },
                { value: "gpt-5.4", label: "gpt-5.4" },
              ],
            },
            efforts: [],
          },
        },
      },
    });

    expect(next.runtimePicker.selectedProvider).toBe("codex");
    expect(next.runtimePicker.models.map((option) => option.value)).toEqual(["gpt-5.5", "gpt-5.4"]);
  });

  it("closes stale resume selection modals when the history list changes", () => {
    const next = appReducer(
      {
        ...initialAppState,
        sessionId: "session-current",
        modal: {
          kind: "backend",
          payload: {
            command: "resume",
            select_options: [{ value: "saved-a", label: "05/05 04:12 6msg", description: "역질문 테스트" }],
          },
        },
      },
      { type: "set_history", history: [] },
    );

    expect(next.modal).toBeNull();
  });

  it("keeps queued and steering user transcript items visible", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "추가 지시", kind: "steering" } },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].text).toBe("추가 지시");
    expect(next.messages[0].kind).toBe("steering");
  });

  it("hides plan mode steering transcript items", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "/plan", kind: "steering" } },
    });

    expect(next.messages).toHaveLength(0);
  });

  it("hides plan mode status transcript items", () => {
    const enabled = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "system", text: "Plan mode enabled." } },
    });
    const disabled = appReducer(enabled, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "system", text: "Plan mode disabled." } },
    });

    expect(disabled.messages).toHaveLength(0);
  });

  it("hides localized plan mode status transcript items", () => {
    const enabled = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "system", text: "계획 모드를 켰습니다." } },
    });
    const disabled = appReducer(enabled, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "system", text: "계획 모드를 껐습니다." } },
    });

    expect(disabled.messages).toHaveLength(0);
  });

  it("marks the ui idle on line completion", () => {
    const busy = appReducer(initialAppState, { type: "set_busy", value: true });
    const next = appReducer(busy, { type: "backend_event", event: { type: "line_complete" } });

    expect(next.busy).toBe(false);
    expect(next.artifactRefreshKey).toBe(busy.artifactRefreshKey + 1);
    expect(next.historyRefreshKey).toBe(busy.historyRefreshKey + 1);
  });

  it("clears initial-only workflow progress when a turn completes without work events", () => {
    const requested = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "[image attachments: 1]" },
    });
    const completed = appReducer(requested, {
      type: "backend_event",
      event: { type: "line_complete" },
    });

    expect(completed.busy).toBe(false);
    expect(completed.workflowEvents).toHaveLength(0);
    expect(completed.workflowAnchorMessageId).toBeNull();
    expect(Object.values(completed.workflowEventsByMessageId).flat()).toHaveLength(0);
  });

  it("refreshes artifacts only when the final assistant answer completes", () => {
    const withToolCall = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "도구 호출 준비", has_tool_uses: true },
    });
    const completed = appReducer(withToolCall, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "완료했습니다.", has_tool_uses: false },
    });

    expect(withToolCall.artifactRefreshKey).toBe(initialAppState.artifactRefreshKey);
    expect(completed.artifactRefreshKey).toBe(withToolCall.artifactRefreshKey + 1);
  });

  it("measures workflow duration from the user request across stage changes", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-05T00:00:00Z"));
      const withUserMessage = appReducer(initialAppState, {
        type: "append_message",
        message: { role: "user", text: "테스트해줘" },
      });

      vi.setSystemTime(new Date("2026-05-05T00:00:02Z"));
      const withTool = appReducer(withUserMessage, {
        type: "backend_event",
        event: { type: "tool_started", tool_name: "shell_command", tool_input: { command: "npm test" } },
      });

      vi.setSystemTime(new Date("2026-05-05T00:00:05Z"));
      const withAnswer = appReducer(withTool, {
        type: "backend_event",
        event: { type: "assistant_delta", message: "완료했습니다." },
      });

      vi.setSystemTime(new Date("2026-05-05T00:00:07Z"));
      const completed = appReducer(withAnswer, {
        type: "backend_event",
        event: { type: "line_complete" },
      });

      expect(completed.workflowDurationSeconds).toBe(7);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps backend errors visible after line completion", () => {
    const withUserMessage = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "하이????" },
    });
    const errored = appReducer(withUserMessage, {
      type: "backend_event",
      event: { type: "error", message: "Network error: Connection error." },
    });
    const completed = appReducer(errored, {
      type: "backend_event",
      event: { type: "line_complete" },
    });

    expect(completed.busy).toBe(false);
    expect(completed.status).toBe("error");
    expect(completed.messages).toHaveLength(2);
    expect(completed.messages[1].role).toBe("system");
    expect(completed.messages[1].isError).toBe(true);
    expect(completed.messages[1].text).toContain("Network error");
  });

  it("drops a dead backend session so the UI can reconnect instead of reusing it", () => {
    const started = appReducer(initialAppState, {
      type: "session_started",
      sessionId: "dead-session",
      clientId: "client-1",
    });
    const busy = appReducer(started, { type: "set_busy", value: true });
    const next = appReducer(busy, {
      type: "backend_event",
      event: { type: "shutdown", message: "Backend exited with code 1" },
    });

    expect(next.sessionId).toBeNull();
    expect(next.busy).toBe(false);
    expect(next.ready).toBe(false);
    expect(next.status).toBe("connecting");
    expect(next.statusText).toBe("세션이 종료되어 새 세션에 다시 연결 중입니다.");
    expect(next.messages.at(-1)?.text).toContain("진행 중이던 세션이 종료되었습니다.");
  });

  it("marks in-flight workflow steps as failed when the backend shuts down", () => {
    const withUserMessage = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "보고서 만들어줘" },
    });
    const withStreamingWrite = appReducer(withUserMessage, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"hello",
      },
    });
    const next = appReducer(withStreamingWrite, {
      type: "backend_event",
      event: { type: "shutdown", message: "Backend exited with code 4294967295" },
    });

    const writeEvent = next.workflowEvents.find((event) => event.toolName === "write_file");
    expect(next.busy).toBe(false);
    expect(next.workflowEvents.some((event) => event.status === "running")).toBe(false);
    expect(writeEvent?.status).toBe("error");
    expect(writeEvent?.detail).toBe("백엔드가 종료되어 작업을 중단했습니다.");
    expect(next.workflowEvents.find((event) => event.role === "purpose")?.status).toBe("error");
  });

  it("marks in-flight workflow steps as failed when the backend reports an error", () => {
    const withStreamingWrite = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"hello",
      },
    });
    const next = appReducer(withStreamingWrite, {
      type: "backend_event",
      event: { type: "error", message: "Network error: Connection error." },
    });

    const writeEvent = next.workflowEvents.find((event) => event.toolName === "write_file");
    expect(next.busy).toBe(false);
    expect(next.status).toBe("error");
    expect(next.workflowEvents.some((event) => event.status === "running")).toBe(false);
    expect(writeEvent?.status).toBe("error");
    expect(writeEvent?.detail).toBe("오류로 작업을 중단했습니다.");
  });

  it("ignores shutdown events from a stale backend session", () => {
    const current = {
      ...initialAppState,
      sessionId: "current-session",
      clientId: "client-1",
      ready: true,
      status: "ready" as const,
      statusText: "준비됨",
    };
    const next = appReducer(current, {
      type: "backend_event",
      sessionId: "old-session",
      event: { type: "shutdown", message: "Backend exited with code 0" },
    });

    expect(next.sessionId).toBe("current-session");
    expect(next.ready).toBe(true);
    expect(next.status).toBe("ready");
  });

  it("renders stale session errors as actionable Korean text", () => {
    const errored = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "error", message: "Unknown session" },
    });

    expect(errored.messages[0].text).toBe("세션 연결이 끊겼습니다. 페이지를 새로고침하거나 새 세션을 시작한 뒤 다시 시도해주세요.");
    expect(errored.statusText).toBe("세션 연결이 끊겼습니다. 페이지를 새로고침하거나 새 세션을 시작한 뒤 다시 시도해주세요.");
  });

  it("localizes the known brainstorming browser prompt before display", () => {
    const prompt = "Some of what we're working on might be easier to explain if I can show it to you in a web browser. I can put together mockups, diagrams, comparisons, and other visuals as we go. This feature is still new and can be token-intensive. Want to try it? (Requires opening a local URL)";
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "assistant_complete", message: prompt },
    });

    expect(next.messages[0].text).toBe("브라우저로 간단한 목업, 다이어그램, 비교 화면 같은 시각 자료를 함께 보여드리면 더 설명하기 쉬울 수 있습니다. 이 기능은 아직 새 기능이라 토큰을 조금 더 쓸 수 있습니다. 사용해볼까요? (로컬 URL을 여는 과정이 필요합니다)");
  });

  it("keeps completed assistant transcript items when the final assistant answer arrives", () => {
    const withTranscript = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "assistant", text: "스킬 원문 전문" } },
    });
    const next = appReducer(withTranscript, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "원문을 위에 표시했습니다.", has_tool_uses: false },
    });

    expect(next.messages.map((message) => message.text)).toEqual([
      "스킬 원문 전문",
      "원문을 위에 표시했습니다.",
    ]);
  });

  it("tracks tool completion without rendering raw tool output as a chat message", () => {
    const started = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "skill", tool_input: { name: "using-superpowers" } },
    });
    const next = appReducer(started, {
      type: "backend_event",
      event: { type: "tool_completed", tool_name: "skill", output: "Skill: using-superpowers" },
    });

    expect(next.messages).toHaveLength(0);
    expect(next.workflowEvents.map((event) => event.title)).toEqual([
      "요청 이해",
      "작업 계획 수립",
      "작업 실행",
      "skill",
      "다음 단계 검토 중",
    ]);
    expect(next.workflowEvents.find((event) => event.toolName === "skill")?.status).toBe("done");
  });

  it("does not start workflow progress for slash command messages", () => {
    const next = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "/provider" },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].text).toBe("/provider");
    expect(next.workflowEvents).toHaveLength(0);
    expect(next.workflowAnchorMessageId).toBeNull();
    expect(next.workflowStartedAtMs).toBeNull();
  });

  it("treats slashes in the middle of a sentence as a normal LLM request", () => {
    const next = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "이 요청에서는 /provider 값을 설명해줘" },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].text).toBe("이 요청에서는 /provider 값을 설명해줘");
    expect(next.workflowEvents.map((event) => event.title)).toEqual([
      "요청 이해",
      "작업 계획 수립",
    ]);
    expect(next.workflowAnchorMessageId).not.toBeNull();
    expect(next.workflowStartedAtMs).not.toBeNull();
  });

  it("does not start workflow progress for slash command transcripts from the backend", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "transcript_item",
        item: { role: "user", text: "/model" },
      },
    });

    expect(next.messages).toHaveLength(1);
    expect(next.messages[0].text).toBe("/model");
    expect(next.workflowEvents).toHaveLength(0);
    expect(next.workflowAnchorMessageId).toBeNull();
    expect(next.workflowStartedAtMs).toBeNull();
  });

  it("does not synthesize workflow progress for command errors without an active workflow", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "error", message: "Unknown select command: subagent_model" },
    });

    expect(next.messages[0].text).toBe("Unknown select command: subagent_model");
    expect(next.workflowEvents).toHaveLength(0);
  });

  it("stores todo markdown from backend updates", () => {
    const next = appReducer({ ...initialAppState, sessionId: "session-1" }, {
      type: "backend_event",
      event: { type: "todo_update", todo_markdown: "- [ ] 조사\n- [x] 정리" },
    });

    expect(next.todoMarkdown).toContain("조사");
    expect(next.todoSessionId).toBe("session-1");
  });

  it("scopes todo markdown to the active restored history session", () => {
    const next = appReducer(
      { ...initialAppState, sessionId: "live-session", activeHistoryId: "saved-session" },
      {
        type: "backend_event",
        event: { type: "todo_update", todo_markdown: "- [ ] 복원 세션 작업" },
      },
    );

    expect(next.todoMarkdown).toContain("복원 세션 작업");
    expect(next.todoSessionId).toBe("saved-session");
  });

  it("preserves and resets todo collapsed state like the legacy checklist", () => {
    const shown = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "todo_update", todo_markdown: "- [ ] 조사" },
    });
    const collapsed = appReducer(shown, { type: "toggle_todo_collapsed" });
    const updated = appReducer(collapsed, {
      type: "backend_event",
      event: { type: "todo_update", todo_markdown: "- [x] 조사\n- [ ] 반영" },
    });
    const dismissed = appReducer(updated, { type: "dismiss_todo" });

    expect(collapsed.todoCollapsed).toBe(true);
    expect(updated.todoCollapsed).toBe(true);
    expect(dismissed.todoCollapsed).toBe(false);
    expect(dismissed.todoSessionId).toBeNull();
  });

  it("collapses the todo checklist when every checklist item is completed", () => {
    const shown = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "todo_update", todo_markdown: "- [ ] 조사\n- [x] 정리" },
    });
    const completed = appReducer(shown, {
      type: "backend_event",
      event: { type: "todo_update", todo_markdown: "- [x] 조사\n- [x] 정리" },
    });

    expect(shown.todoCollapsed).toBe(false);
    expect(completed.todoCollapsed).toBe(true);
  });

  it("collapses the todo checklist when the final assistant answer completes", () => {
    const withTodo = appReducer(initialAppState, {
      type: "backend_event",
      event: { type: "todo_update", todo_markdown: "- [ ] 조사\n- [ ] 답변" },
    });
    const completed = appReducer(withTodo, {
      type: "backend_event",
      event: { type: "assistant_complete", message: "완료했습니다.", has_tool_uses: false },
    });

    expect(withTodo.todoCollapsed).toBe(false);
    expect(completed.todoCollapsed).toBe(true);
  });

  it("applies generated session titles to the active chat and history", () => {
    const base = {
      ...initialAppState,
      sessionId: "session-1",
      history: [
        { value: "session-1", label: "오늘", description: "MyHarness" },
        { value: "session-2", label: "어제", description: "다른 제목" },
      ],
    };

    const next = appReducer(base, {
      type: "backend_event",
      event: { type: "session_title", message: "React 제목 생성 수정" },
    });

    expect(next.chatTitle).toBe("React 제목 생성 수정");
    expect(next.history[0].description).toBe("React 제목 생성 수정");
    expect(next.history[1].description).toBe("다른 제목");
  });

  it("tracks the backend saved session id as the active history item", () => {
    const next = appReducer(
      {
        ...initialAppState,
        restoringHistory: true,
      },
      {
        type: "backend_event",
        event: { type: "active_session", value: "saved-session-1" },
      },
    );

    expect(next.activeHistoryId).toBe("saved-session-1");
    expect(next.restoringHistory).toBe(false);
  });

  it("keeps pending history restore state through stale active session echoes", () => {
    const next = appReducer(
      {
        ...initialAppState,
        activeHistoryId: "current-session",
        pendingHistoryId: "saved-session",
        restoringHistory: true,
      },
      {
        type: "backend_event",
        event: { type: "active_session", value: "current-session" },
      },
    );

    expect(next.activeHistoryId).toBe("current-session");
    expect(next.pendingHistoryId).toBe("saved-session");
    expect(next.restoringHistory).toBe(true);
  });

  it("keeps an immediately saved new chat row when switching away", () => {
    const started = appReducer(
      {
        ...initialAppState,
        sessionId: "web-session",
        workspaceName: "Default",
        workspacePath: "C:/demo",
        history: [{ value: "saved-old", label: "5/3 10:00 2 msg", description: "이전 대화" }],
        messages: [{ id: "message-1", role: "user", text: "이전 질문" }],
      },
      { type: "begin_new_chat", sessionId: "abcdef123456" },
    );
    const restoringOld = appReducer(started, { type: "begin_history_restore", sessionId: "saved-old" });

    expect(started.activeHistoryId).toBe("abcdef123456");
    expect(started.pendingFreshChat).toBe(false);
    expect(started.history[0].value).toBe("abcdef123456");
    expect(started.history[0].description).toBe("새 대화");
    expect(started.history[0].pending).toBe(true);
    expect(restoringOld.history.some((item) => item.value === "abcdef123456")).toBe(true);
  });

  it("rebuilds visible chat from restored history snapshots", () => {
    const busy = appReducer(
      {
        ...initialAppState,
        busy: true,
        messages: [{ id: "old", role: "system", text: "히스토리 복원 중" }],
      },
      {
        type: "backend_event",
        event: {
          type: "history_snapshot",
          history_events: [
            { type: "user", text: "첫 질문" },
            { type: "assistant", text: "첫 답변" },
            { type: "tool_started", tool_name: "shell_command", tool_input: { command: "pytest" } },
            { type: "tool_completed", tool_name: "shell_command", output: "passed", is_error: false },
            { type: "user", text: "후속 질문" },
          ],
        },
      },
    );

    expect(busy.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "첫 질문"],
      ["user", "후속 질문"],
    ]);
    const restoredWorkflowEvents = Object.values(busy.workflowEventsByMessageId).flat();
    expect(restoredWorkflowEvents.find((event) => event.role === "planning")?.detail).toBe("첫 답변");
    const shellEvent = restoredWorkflowEvents.find((event) => event.toolName === "shell_command");
    expect(shellEvent?.status).toBe("done");
    expect(shellEvent?.output).toBe("passed");
    expect(busy.workflowEvents).toHaveLength(0);
    expect(busy.workflowAnchorMessageId).toBeNull();
  });

  it("does not restore a stale running planning step for simple history turns", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "이미지 첨부만 한 요청" },
          { type: "assistant", text: "확인했습니다." },
        ],
      },
    });

    expect(restored.workflowEvents).toHaveLength(0);
    expect(restored.workflowAnchorMessageId).toBeNull();
    expect(Object.values(restored.workflowEventsByMessageId).flat()).toHaveLength(0);
  });

  it("restores saved duration for completed simple history turns", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "간단히 답해줘" },
          { type: "assistant", text: "답변입니다." },
          { type: "line_complete", workflow_duration_seconds: 12 },
        ],
      },
    });

    const userMessageId = restored.messages[0].id;

    expect(restored.workflowAnchorMessageId).toBe(userMessageId);
    expect(restored.workflowDurationSeconds).toBe(12);
    expect(restored.workflowDurationSecondsByMessageId[userMessageId]).toBe(12);
    expect(restored.workflowEvents.some((event) => event.role === "final" && event.status === "done")).toBe(true);
  });

  it("restores legacy compact duration metadata for the latest completed history turn", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        compact_metadata: { workflow_duration_seconds: 9 },
        history_events: [
          { type: "user", text: "이전 저장 질문" },
          { type: "assistant", text: "이전 저장 답변" },
        ],
      },
    });

    const userMessageId = restored.messages[0].id;

    expect(restored.workflowAnchorMessageId).toBe(userMessageId);
    expect(restored.workflowDurationSeconds).toBe(9);
    expect(restored.workflowDurationSecondsByMessageId[userMessageId]).toBe(9);
  });

  it("does not restore workflow progress for a history turn with only a user message", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "[image attachments: 1]" },
        ],
      },
    });

    expect(restored.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "[image attachments: 1]"],
    ]);
    expect(restored.workflowEvents).toHaveLength(0);
    expect(restored.workflowAnchorMessageId).toBeNull();
  });

  it("keeps the current messages through the restore clear event until the history snapshot arrives", () => {
    const restoring = {
      ...initialAppState,
      activeHistoryId: "current-session",
      pendingHistoryId: "saved-session",
      restoringHistory: true,
      busy: true,
      messages: [{ id: "current-message", role: "user" as const, text: "현재 화면 질문" }],
    };

    const afterClear = appReducer(restoring, {
      type: "backend_event",
      event: { type: "clear_transcript" },
    });

    expect(afterClear.messages).toEqual(restoring.messages);
    expect(afterClear.activeHistoryId).toBe("current-session");
    expect(afterClear.pendingHistoryId).toBe("saved-session");

    const restored = appReducer(afterClear, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        value: "saved-session",
        history_events: [
          { type: "user", text: "저장된 질문" },
          { type: "assistant", text: "저장된 답변" },
        ],
      },
    });

    expect(restored.messages.map((message) => message.text)).toEqual(["저장된 질문", "저장된 답변"]);
    expect(restored.activeHistoryId).toBe("saved-session");
    expect(restored.pendingHistoryId).toBeNull();
  });

  it("restores a busy live session view when returning from another history session", () => {
    const activeUser = appReducer(
      {
        ...initialAppState,
        sessionId: "live-a",
        activeHistoryId: "saved-a",
        chatTitle: "진행 중 질문",
      },
      {
        type: "append_message",
        message: { role: "user", text: "보고서 작성해줘" },
      },
    );
    const activeStreaming = appReducer(activeUser, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "초안 작성 중" },
      sessionId: "live-a",
    });
    const restoringOther = appReducer(activeStreaming, { type: "begin_history_restore", sessionId: "saved-b" });
    const otherSession = appReducer(restoringOther, {
      type: "session_started",
      sessionId: "live-b",
      clientId: "client-1",
    });
    const restoredOther = appReducer(otherSession, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        value: "saved-b",
        history_events: [
          { type: "user", text: "다른 질문" },
          { type: "assistant", text: "다른 답변" },
        ],
      },
      sessionId: "live-b",
    });
    const returning = appReducer(restoredOther, { type: "begin_history_restore", sessionId: "saved-a" });
    const reattached = appReducer(returning, {
      type: "session_started",
      sessionId: "live-a",
      clientId: "client-1",
      busy: true,
    });

    expect(reattached.messages.map((message) => message.text)).toEqual(["보고서 작성해줘", "초안 작성 중"]);
    expect(reattached.activeHistoryId).toBe("saved-a");
    expect(reattached.busy).toBe(true);

    const afterReplayClear = appReducer(reattached, {
      type: "backend_event",
      event: { type: "clear_transcript" } as any,
      sessionId: "live-a",
    });
    const afterReplayUser = appReducer(afterReplayClear, {
      type: "backend_event",
      event: { type: "transcript_item", item: { role: "user", text: "보고서 작성해줘" } },
      sessionId: "live-a",
    });
    const afterReplayDelta = appReducer(afterReplayUser, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "초안 작성 중 최신 문장" },
      sessionId: "live-a",
    });

    expect(afterReplayDelta.messages.map((message) => message.text)).toEqual(["보고서 작성해줘", "초안 작성 중 최신 문장"]);
  });

  it("restores swarm status from history snapshots", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "AI team으로 조사해줘" },
          {
            type: "swarm_status",
            swarm_teammates: [
              {
                id: "agent-1",
                name: "Research",
                role: "research",
                status: "running",
                task: "Collect sources",
                lastOutput: "2 sources checked",
              },
            ],
            swarm_notifications: [{ id: "note-1", from: "Research", message: "Started", timestamp: 123 }],
          },
          { type: "assistant", text: "진행 중입니다." },
        ],
      },
    });

    expect(restored.swarmTeammates).toEqual([
      {
        id: "agent-1",
        name: "Research",
        role: "research",
        status: "running",
        task: "Collect sources",
        startedAt: null,
        endedAt: null,
        lastOutput: "2 sources checked",
        taskId: "",
        model: "",
        modelSource: "",
        prompt: "",
      },
    ]);
    expect(restored.swarmNotifications[0]).toMatchObject({
      id: "note-1",
      from: "Research",
      message: "Started",
      timestamp: 123,
    });
  });

  it("marks final assistant turns complete when restoring history", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "질문" },
          { type: "assistant", text: "최종 답변" },
        ],
      },
    });

    expect(restored.messages[1].isComplete).toBe(true);
  });

  it("restores streamed write previews from history tool input deltas", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "HTML 파일 만들어줘" },
          {
            type: "tool_input_delta",
            tool_name: "write_file",
            tool_call_index: 0,
            arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"<h1>",
          },
          {
            type: "tool_input_delta",
            tool_name: "write_file",
            tool_call_index: 0,
            arguments_delta: "Live</h1>",
          },
        ],
      },
    });

    const writeEvents = restored.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].status).toBe("running");
    expect(writeEvents[0].toolInput?.path).toBe("outputs/live.html");
    expect(writeEvents[0].toolInput?.content).toBe("<h1>Live</h1>");
  });

  it("does not duplicate restored streamed previews when the matching tool start is replayed", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        history_events: [
          { type: "user", text: "HTML 파일 만들어줘" },
          {
            type: "tool_input_delta",
            tool_name: "write_file",
            tool_call_index: 0,
            arguments_delta: "{\"path\":\"outputs/live.html\",\"content\":\"<h1>Live</h1>",
          },
          {
            type: "tool_started",
            tool_name: "write_file",
            tool_call_index: 0,
            tool_input: { path: "outputs/live.html", content: "<h1>Live</h1>" },
          },
        ],
      },
    });

    const writeEvents = restored.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].toolInput?.content).toBe("<h1>Live</h1>");
  });

  it("keeps completed history snapshots inert against later backend events", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        value: "saved-session",
        history_events: [
          { type: "user", text: "완료된 질문" },
          { type: "assistant", text: "완료된 답변" },
        ],
      },
    });

    const withModal = appReducer(restored, {
      type: "backend_event",
      event: { type: "modal_request", modal: { kind: "question", question: "끼어들면 안 됨" } },
    });
    const withDelta = appReducer(withModal, {
      type: "backend_event",
      event: { type: "assistant_delta", value: "새로 끼어든 답변" },
    });
    const withComplete = appReducer(withDelta, {
      type: "backend_event",
      event: { type: "line_complete" },
    });

    expect(withComplete.messages.map((message) => message.text)).toEqual(["완료된 질문", "완료된 답변"]);
    expect(withComplete.modal).toBeNull();
    expect(withComplete.busy).toBe(false);
    expect(withComplete.historyRefreshKey).toBe(restored.historyRefreshKey);
  });

  it("reactivates a completed history session when the user sends a local follow-up", () => {
    const restored = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "history_snapshot",
        value: "saved-session",
        history_events: [
          { type: "user", text: "완료된 질문" },
          { type: "assistant", text: "완료된 답변" },
        ],
      },
    });
    const followUp = appReducer(restored, {
      type: "append_message",
      message: {
        role: "log",
        text: "!pwd",
        toolName: "shell-shortcut",
        terminal: { command: "pwd", status: "running" },
      },
    });
    const withDelta = appReducer(followUp, {
      type: "backend_event",
      event: { type: "assistant_delta", value: "후속 응답" },
    });

    expect(followUp.historyReadOnly).toBe(false);
    expect(withDelta.messages.map((message) => message.text)).toEqual(["완료된 질문", "완료된 답변", "!pwd", "후속 응답"]);
  });

  it("closes floating work surfaces when entering history restore", () => {
    const restoring = appReducer(
      {
        ...initialAppState,
        activeHistoryId: "current-session",
        modal: { kind: "settings" },
        artifactPanelOpen: true,
        activeArtifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
        activeArtifactPayload: { kind: "html", content: "<p>report</p>" },
        swarmPopupOpen: true,
      },
      { type: "begin_history_restore", sessionId: "saved-session" },
    );

    expect(restoring.activeHistoryId).toBe("current-session");
    expect(restoring.pendingHistoryId).toBe("saved-session");
    expect(restoring.modal).toBeNull();
    expect(restoring.artifactPanelOpen).toBe(false);
    expect(restoring.activeArtifact).toBeNull();
    expect(restoring.activeArtifactPayload).toBeNull();
    expect(restoring.swarmPopupOpen).toBe(false);
  });

  it("tracks tool workflow lifecycle", () => {
    const active = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "테스트를 실행해줘" },
    });
    const started = appReducer(active, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "shell_command", tool_input: { command: "npm test" } },
    });
    const progressed = appReducer(started, {
      type: "backend_event",
      event: { type: "tool_progress", tool_name: "shell_command", message: "테스트 실행 중" },
    });
    const reported = appReducer(started, {
      type: "backend_event",
      event: { type: "status", message: "테스트 스크립트 실행 결과를 확인하고 있습니다." },
    });
    const completed = appReducer(progressed, {
      type: "backend_event",
      event: { type: "tool_completed", tool_name: "shell_command", output: "pass" },
    });

    const shellEvent = completed.workflowEvents.find((event) => event.toolName === "shell_command");
    const startedPurpose = started.workflowEvents.find((event) => event.role === "purpose");
    const reportedPurpose = reported.workflowEvents.find((event) => event.role === "purpose");
    const completedPurpose = completed.workflowEvents.find((event) => event.role === "purpose");
    expect(started.busy).toBe(true);
    expect(progressed.busy).toBe(true);
    expect(completed.busy).toBe(true);
    expect(completed.workflowEvents.map((event) => event.title)).toContain("작업 실행");
    expect(startedPurpose?.detail).toBe("필요한 변경이나 명령을 실행하고 있습니다.");
    expect(startedPurpose?.detail).not.toContain("npm test");
    expect(reportedPurpose?.detail).toBe("테스트 스크립트 실행 결과를 확인하고 있습니다.");
    expect(reported.workflowEvents.some((event) => event.role === "waiting")).toBe(false);
    expect(completedPurpose?.detail).toBe("작업 실행을 마쳤습니다.");
    expect(completedPurpose?.detail).not.toContain("npm test");
    expect(completedPurpose?.detail).not.toContain("pass");
    expect(shellEvent?.status).toBe("done");
    expect(shellEvent?.detail).toContain("pass");
    expect(completed.artifactRefreshKey).toBe(progressed.artifactRefreshKey);
  });

  it("keeps interim workflow judgments and replaced details as visible history", () => {
    const active = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "자료를 확인하고 정리해줘" },
    });
    const firstStarted = appReducer(active, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "web_fetch", tool_input: { url: "https://example.com/a" } },
    });
    const firstCompleted = appReducer(firstStarted, {
      type: "backend_event",
      event: { type: "tool_completed", tool_name: "web_fetch", output: "first result" },
    });
    const secondStarted = appReducer(firstCompleted, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "web_search", tool_input: { query: "second" } },
    });
    const noted = appReducer(secondStarted, {
      type: "backend_event",
      event: { type: "status", message: "추가 검색 결과를 비교하고 있습니다." },
    });
    const secondCompleted = appReducer(secondStarted, {
      type: "backend_event",
      event: { type: "tool_completed", tool_name: "web_search", output: "second result" },
    });

    const activityEvent = secondStarted.workflowEvents.find((event) => event.role === "activity");
    const purposeEvent = noted.workflowEvents.find((event) => event.role === "purpose" && event.purpose === "info");

    expect(activityEvent?.status).toBe("done");
    expect(activityEvent?.detail).toBe("다음 작업을 정했습니다.");
    expect(activityEvent?.detailLog?.[0]).toContain("도구 결과를 읽고");
    expect(purposeEvent?.detail).toBe("추가 검색 결과를 비교하고 있습니다.");
    expect(purposeEvent?.detailLog?.length).toBeGreaterThan(0);
    expect(secondCompleted.workflowEvents.filter((event) => event.role === "activity")).toHaveLength(1);
  });

  it("anchors workflow progress to the actual user request and status notes", () => {
    const active = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "새 대화 직후 히스토리 목록이 비는 문제를 고쳐줘" },
    });
    const noted = appReducer(active, {
      type: "backend_event",
      event: { type: "status", message: "히스토리 목록 갱신 경로를 확인하고 있습니다." },
    });

    const planningEvent = noted.workflowEvents.find((event) => event.role === "planning");
    expect(noted.workflowEvents[0].detail).toContain("새 대화 직후 히스토리 목록");
    expect(planningEvent?.detail).toBe("히스토리 목록 갱신 경로를 확인하고 있습니다.");
    expect(noted.workflowEvents.some((event) => event.role === "waiting")).toBe(false);
  });

  it("keeps streamed assistant progress text visible when tools follow", () => {
    const active = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "진행 표시를 더 구체적으로 만들어줘" },
    });
    const streaming = appReducer(active, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "먼저 workflow reducer와 렌더링 컴포넌트를 확인하겠습니다." },
    });
    const toolPending = appReducer(streaming, {
      type: "backend_event",
      event: {
        type: "assistant_complete",
        message: "먼저 workflow reducer와 렌더링 컴포넌트를 확인하겠습니다.",
        has_tool_uses: true,
      },
    });

    const planningEvent = toolPending.workflowEvents.find((event) => event.role === "planning");
    expect(toolPending.messages.map((message) => [message.role, message.text, message.isComplete])).toEqual([
      ["user", "진행 표시를 더 구체적으로 만들어줘", undefined],
      ["assistant", "먼저 workflow reducer와 렌더링 컴포넌트를 확인하겠습니다.", true],
    ]);
    expect(planningEvent?.detail).toContain("workflow reducer");
    expect(toolPending.workflowEvents.some((event) => event.role === "waiting")).toBe(false);
    expect(toolPending.workflowEvents.some((event) => event.role === "final")).toBe(false);
  });

  it("uses the Korean skill snapshot description in workflow progress", () => {
    const withSkills = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "skills_snapshot",
        skills: [
          {
            name: "insane-search",
            description: "차단된 웹사이트를 자동으로 우회하기 위해 가능한 방법을 순차적으로 시도합니다.",
            enabled: true,
          },
        ],
      },
    });
    const started = appReducer(withSkills, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "skill", tool_input: { name: "insane-search" } },
    });
    const completed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "skill",
        output: "Skill: insane-search\nDescription: Try bypass methods in order.\n\n# Skill",
      },
    });

    const startedSkill = started.workflowEvents.find((event) => event.toolName === "skill");
    const completedSkill = completed.workflowEvents.find((event) => event.toolName === "skill");

    expect(started.statusText).toBe("스킬 확인 중");
    expect(startedSkill?.title).toBe("skill");
    expect(startedSkill?.detail).toContain("insane-search");
    expect(startedSkill?.detail).toContain("차단된 웹사이트");
    expect(completedSkill?.detail).toContain("차단된 웹사이트");
    expect(completedSkill?.detail).not.toContain("Try bypass methods");
  });

  it("keeps parallel same-named tool steps matched to their backend call ids", () => {
    const firstStarted = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "web_search",
        tool_call_id: "call-first",
        tool_call_index: 0,
        tool_input: { query: "first query" },
      } as any,
    });
    const secondStarted = appReducer(firstStarted, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "web_search",
        tool_call_id: "call-second",
        tool_call_index: 1,
        tool_input: { query: "second query" },
      } as any,
    });
    const startedSearchEvents = secondStarted.workflowEvents.filter((event) => event.toolName === "web_search");
    expect(startedSearchEvents).toHaveLength(2);
    expect(startedSearchEvents.map((event) => event.status)).toEqual(["running", "running"]);

    const firstCompleted = appReducer(secondStarted, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "web_search",
        tool_call_id: "call-first",
        output: "Search results for: first query",
      } as any,
    });
    const completed = appReducer(firstCompleted, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "web_search",
        tool_call_id: "call-second",
        output: "Search results for: second query",
      } as any,
    });

    const searchEvents = completed.workflowEvents.filter((event) => event.toolName === "web_search");
    expect(searchEvents).toHaveLength(2);
    expect(searchEvents.map((event) => event.status)).toEqual(["done", "done"]);
    expect(searchEvents.map((event) => event.detail)).toEqual([
      "Search results for: first query",
      "Search results for: second query",
    ]);
  });

  it("keeps todo_write failures as failures in workflow detail", () => {
    const started = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "todo_write",
        tool_call_id: "call-todo",
        tool_input: {},
      } as any,
    });
    const completed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "todo_write",
        tool_call_id: "call-todo",
        output: "Invalid input for todo_write: Either item or todos must be provided",
        is_error: true,
      } as any,
    });

    const todoEvent = completed.workflowEvents.find((event) => event.toolName === "todo_write");
    expect(todoEvent?.status).toBe("error");
    expect(todoEvent?.detail).toContain("입력 형식 오류");
    expect(todoEvent?.detail).not.toContain("todo_write");
    expect(todoEvent?.detail).not.toContain("정리했습니다");
  });

  it("treats blocked web research tool failures as warnings instead of failing the whole purpose group", () => {
    const startedSearch = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "web_search",
        tool_call_id: "call-search",
        tool_input: { query: "Neon Genesis Evangelion overview production impact official" },
      } as any,
    });
    const completedSearch = appReducer(startedSearch, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "web_search",
        tool_call_id: "call-search",
        output: "Search results for: Neon Genesis Evangelion overview production impact official",
      } as any,
    });
    const startedFetch = appReducer(completedSearch, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "web_fetch",
        tool_call_id: "call-fetch",
        tool_input: { url: "https://en.wikipedia.org/wiki/Neon_Genesis_Evangelion" },
      } as any,
    });
    const completedFetch = appReducer(startedFetch, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "web_fetch",
        tool_call_id: "call-fetch",
        output: "web_fetch failed: Client error '403 Forbidden' for url 'https://en.wikipedia.org/wiki/Neon_Genesis_Evangelion'",
        is_error: true,
      } as any,
    });

    const purpose = completedFetch.workflowEvents.find((event) => event.role === "purpose");
    const fetchStep = completedFetch.workflowEvents.find((event) => event.toolName === "web_fetch");

    expect(fetchStep?.status).toBe("warning");
    expect(purpose?.status).toBe("warning");
    expect(purpose?.detail).toBe("일부 자료 확인에 실패했지만, 가능한 정보로 계속 진행합니다.");
    expect(fetchStep?.detail).toContain("403 Forbidden");
  });

  it("keeps the header status compact for web tools and answer streaming", () => {
    const started = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "web_fetch",
        tool_input: { url: "https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/superagency-in-the-workplace-empowering" },
      },
    });
    const progressed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_progress",
        tool_name: "web_fetch",
        message: "web_fetch 실행 중... 6초 경과 · https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/superagency-in-the-workplace-empowering",
      },
    });
    const completed = appReducer(progressed, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "web_fetch",
        output: "URL: https://www.mckinsey.com/capabilities/tech-and-ai/our-insights/superagency-in-the-workplace-empowering\nTitle: Superagency",
      },
    });
    const streaming = appReducer(completed, {
      type: "backend_event",
      event: { type: "assistant_delta", message: "정리하면" },
    });

    expect(started.statusText).toBe("웹 페이지 확인 중");
    expect(progressed.statusText).toBe("웹 페이지 확인 중");
    expect(completed.statusText).toBe("도구 결과 검토 중");
    expect(streaming.statusText).toBe("응답 작성 중");
    expect(progressed.workflowEvents.find((event) => event.toolName === "web_fetch")?.detail).toContain("mckinsey.com");
  });

  it("streams write_file argument deltas into the workflow preview before tool start", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"immortal-ai-worm.html\",\"content\":\"<html><body>",
      },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "<h1>Live</h1>",
      },
    });

    const writeEvent = second.workflowEvents.find((event) => event.toolName === "write_file");
    expect(writeEvent?.status).toBe("running");
    expect(writeEvent?.toolInput?.path).toBe("immortal-ai-worm.html");
    expect(writeEvent?.toolInput?.content).toBe("<html><body><h1>Live</h1>");
  });

  it("does not open the artifact preview while an HTML file is being written", () => {
    const next = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/office-ai-report.html\",\"content\":\"<!doctype html><html><body><h1>Live preview</h1>",
      },
    });

    expect(next.artifactPanelOpen).toBe(false);
    expect(next.activeArtifact).toBeNull();
    expect(next.activeArtifactPayload).toBeNull();
    expect(next.workflowEvents.find((event) => event.toolName === "write_file")?.toolInput?.content)
      .toBe("<!doctype html><html><body><h1>Live preview</h1>");
  });

  it("keeps an already open matching artifact preview stable while an HTML file is being written", () => {
    const streaming = appReducer(
      {
        ...initialAppState,
        artifactPanelOpen: true,
        activeArtifact: { path: "outputs/office-ai-report.html", name: "office-ai-report.html", kind: "html" },
        activeArtifactPayload: {
          path: "outputs/office-ai-report.html",
          name: "office-ai-report.html",
          kind: "html",
          content: "<html><body><h1>Current preview</h1></body></html>",
        },
      },
      {
        type: "backend_event",
        event: {
          type: "tool_input_delta",
          tool_name: "write_file",
          tool_call_index: 0,
          arguments_delta: "{\"path\":\"outputs/office-ai-report.html\",\"content\":\"<!doctype html><html><body><h1>Live preview</h1>",
        },
      },
    );

    expect(streaming.artifactPanelOpen).toBe(true);
    expect(streaming.activeArtifact).toMatchObject({
      path: "outputs/office-ai-report.html",
      name: "office-ai-report.html",
      kind: "html",
    });
    expect(streaming.activeArtifactPayload).toMatchObject({
      path: "outputs/office-ai-report.html",
      kind: "html",
      content: "<html><body><h1>Current preview</h1></body></html>",
    });

    const completed = appReducer(streaming, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "write_file",
        output: "Wrote outputs/office-ai-report.html",
        is_error: false,
      },
    });

    expect(completed.activeArtifactPayload).toMatchObject({
      path: "outputs/office-ai-report.html",
      kind: "html",
      content: "<html><body><h1>Current preview</h1></body></html>",
    });
    expect(completed.artifactRefreshKey).toBe(streaming.artifactRefreshKey);
  });

  it("keeps the streamed write_file preview row when the tool starts and completes", () => {
    const streamed = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        arguments_delta: "{\"path\":\"chart.html\",\"content\":\"hello",
      },
    });
    const started = appReducer(streamed, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "write_file", tool_input: { path: "chart.html", content: "hello" } },
    });
    const completed = appReducer(started, {
      type: "backend_event",
      event: { type: "tool_completed", tool_name: "write_file", output: "Wrote chart.html", is_error: false },
    });

    const writeEvents = completed.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].status).toBe("done");
    expect(writeEvents[0].toolInput?.content).toBe("hello");
  });

  it("merges streamed write previews when backend call ids arrive later", () => {
    const streamed = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        arguments_delta: "{\"path\":\"agent-harness-trend-report.html\",\"content\":\"<!doctype html>",
      },
    });
    const started = appReducer(streamed, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_id: "call-write",
        tool_call_index: 0,
        tool_input: {
          path: "agent-harness-trend-report.html",
          content: "<!doctype html>",
        },
      } as any,
    });
    const completed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "write_file",
        tool_call_id: "call-write",
        tool_call_index: 0,
        output: "Wrote agent-harness-trend-report.html",
        is_error: false,
      } as any,
    });

    const writeEvents = completed.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0]).toMatchObject({
      status: "done",
      toolCallId: "call-write",
      toolCallIndex: 0,
    });
    expect(writeEvents[0].toolInput?.path).toBe("agent-harness-trend-report.html");
  });

  it("shows file write previews even when streamed tool deltas arrive before the tool name", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/evangelion-content-report.html\",\"content\":\"<!doctype html>",
      },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_call_index: 0,
        arguments_delta: "<html><body>streaming</body></html>",
      },
    });
    const previewBeforeStart = second.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(previewBeforeStart).toHaveLength(1);
    expect(previewBeforeStart[0].status).toBe("running");
    expect(previewBeforeStart[0].toolInput?.content).toContain("<body>streaming</body>");

    const started = appReducer(second, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_index: 0,
        tool_input: {
          path: "outputs/evangelion-content-report.html",
          content: "<!doctype html><html><body>streaming</body></html>",
        },
      },
    });

    const writeEvents = started.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].status).toBe("running");
    expect(writeEvents[0].toolInput?.path).toBe("outputs/evangelion-content-report.html");
    expect(writeEvents[0].toolInput?.content).toContain("<body>streaming</body>");
  });

  it("keeps appending to the same file preview when the streamed tool name appears late", () => {
    const unnamed = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/live-report.html\",\"content\":\"hello",
      },
    });
    const named = appReducer(unnamed, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: " world",
      },
    });

    const writeEvents = named.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].toolInput?.content).toBe("hello world");
  });

  it("infers notebook edit previews from unnamed new_source deltas", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_call_index: 1,
        arguments_delta: "{\"path\":\"analysis.ipynb\",\"new_source\":\"print",
      },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_call_index: 1,
        arguments_delta: "(42)",
      },
    });
    const previewBeforeStart = second.workflowEvents.filter((event) => event.toolName === "notebook_edit");
    expect(previewBeforeStart).toHaveLength(1);
    expect(previewBeforeStart[0].toolInput?.new_source).toBe("print(42)");
    expect(second.workflowEvents.some((event) => event.toolName === "write_file")).toBe(false);

    const started = appReducer(second, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "notebook_edit",
        tool_call_index: 1,
        tool_input: {
          path: "analysis.ipynb",
          new_source: "print(42)",
        },
      },
    });

    const notebookEvents = started.workflowEvents.filter((event) => event.toolName === "notebook_edit");
    expect(notebookEvents).toHaveLength(1);
    expect(notebookEvents[0].toolInput?.new_source).toBe("print(42)");
    expect(started.workflowEvents.some((event) => event.toolName === "write_file")).toBe(false);
  });

  it("streams apply_patch argument deltas into the workflow preview before tool start", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "apply_patch",
        tool_call_index: 0,
        arguments_delta: JSON.stringify({
          patch: [
            "*** Begin Patch",
            "*** Update File: outputs/report.html",
            "@@",
            "-<h1>Old</h1>",
          ].join("\n"),
        }).slice(0, -2),
      },
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "apply_patch",
        tool_call_index: 0,
        arguments_delta: "\\n+<h1>New</h1>\\n*** End Patch\"}",
      },
    });

    const patchEvents = second.workflowEvents.filter((event) => event.toolName === "apply_patch");
    expect(patchEvents).toHaveLength(1);
    expect(patchEvents[0].status).toBe("running");
    expect(patchEvents[0].toolInput?.path).toBe("outputs/report.html");
    expect(patchEvents[0].toolInput?.patch).toContain("+<h1>New</h1>");
  });

  it("merges write_file deltas into an already started call when the delta lacks the call id", () => {
    const started = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_id: "call-write",
        tool_input: { path: "outputs/tailwind_design_system_필요성_보고서.html" },
      } as any,
    });
    const streamed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/tailwind_design_system_필요성_보고서.html\",\"content\":\"<!doctype html>",
      },
    });

    const writeEvents = streamed.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0]).toMatchObject({
      status: "running",
      toolCallId: "call-write",
    });
    expect(writeEvents[0].toolInput?.content).toBe("<!doctype html>");
  });

  it("merges write_file progress into the same path without replacing streamed content", () => {
    const started = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_id: "call-write",
        tool_input: { path: "outputs/tailwind_design_system_필요성_보고서.html" },
      } as any,
    });
    const streamed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_input_delta",
        tool_name: "write_file",
        tool_call_index: 0,
        arguments_delta: "{\"path\":\"outputs/tailwind_design_system_필요성_보고서.html\",\"content\":\"<!doctype html>",
      },
    });
    const progressed = appReducer(streamed, {
      type: "backend_event",
      event: {
        type: "tool_progress",
        tool_name: "write_file",
        tool_call_index: 0,
        tool_input: { path: "outputs/tailwind_design_system_필요성_보고서.html" },
        message: "파일 작업 중... 21초 경과 · outputs/tailwind_design_system_필요성_보고서.html",
      },
    });

    const writeEvents = progressed.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].detail).toContain("파일 작업 중");
    expect(writeEvents[0].toolInput?.content).toBe("<!doctype html>");
  });

  it("merges write_file progress into a started same-path call that has no index", () => {
    const started = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_id: "call-write",
        tool_input: {
          path: "outputs/tailwind_design_system_필요성_보고서.html",
          content: "<!doctype html>",
        },
      } as any,
    });
    const progressed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_progress",
        tool_name: "write_file",
        tool_call_index: 0,
        tool_input: { path: "outputs/tailwind_design_system_필요성_보고서.html" },
        message: "파일 작업 중... 21초 경과 · outputs/tailwind_design_system_필요성_보고서.html",
      },
    });

    const writeEvents = progressed.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0].detail).toContain("파일 작업 중");
    expect(writeEvents[0].toolInput?.content).toBe("<!doctype html>");
  });

  it("does not add a second running write_file step for the same path", () => {
    const first = appReducer(initialAppState, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_id: "call-write-1",
        tool_call_index: 0,
        tool_input: {
          path: "outputs/tailwind_design_system_필요성_보고서.html",
          content: "<!doctype html>",
        },
      } as any,
    });
    const second = appReducer(first, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "write_file",
        tool_call_id: "call-write-2",
        tool_call_index: 1,
        tool_input: {
          path: "outputs/tailwind_design_system_필요성_보고서.html",
          content: "<!doctype html><html>",
        },
      } as any,
    });

    const writeEvents = second.workflowEvents.filter((event) => event.toolName === "write_file");
    expect(writeEvents).toHaveLength(1);
    expect(writeEvents[0]).toMatchObject({
      toolCallId: "call-write-2",
      toolCallIndex: 1,
    });
    expect(writeEvents[0].toolInput?.content).toBe("<!doctype html><html>");
  });

  it("merges shell shortcut output into the optimistic terminal message", () => {
    const withTerminal = appReducer(initialAppState, {
      type: "append_message",
      message: {
        role: "log",
        text: "!node --version",
        toolName: "shell-shortcut",
        terminal: { command: "node --version", status: "running" },
      },
    });
    const started = appReducer(withTerminal, {
      type: "backend_event",
      event: { type: "tool_started", tool_name: "cmd", tool_input: { command: "node --version" } },
    });
    const completed = appReducer(started, {
      type: "backend_event",
      event: { type: "tool_completed", tool_name: "cmd", output: "v22.15.0\n", is_error: false },
    });

    expect(completed.messages).toHaveLength(1);
    expect(completed.messages[0].terminal).toEqual({
      command: "node --version",
      output: "v22.15.0\n",
      status: "done",
    });
    expect(completed.messages[0].text).toBe("v22.15.0\n");
  });

  it("shows cmd tool commands as one-line workflow details", () => {
    const withUser = appReducer(initialAppState, {
      type: "append_message",
      message: { role: "user", text: "명령 실행해줘" },
    });
    const busy = appReducer(withUser, { type: "set_busy", value: true });
    const started = appReducer(busy, {
      type: "backend_event",
      event: {
        type: "tool_started",
        tool_name: "cmd",
        tool_input: { cmd: "cmd /c echo hello\ncmd /c echo world" },
      },
    });

    const startedToolEvent = started.workflowEvents.find((event) => event.toolName === "cmd");
    expect(startedToolEvent).toMatchObject({
      title: "명령 실행",
      detail: "cmd /c echo hello cmd /c echo world",
    });

    const completed = appReducer(started, {
      type: "backend_event",
      event: {
        type: "tool_completed",
        tool_name: "cmd",
        output: "hello\nworld\n",
        is_error: false,
      },
    });
    const completedToolEvent = completed.workflowEvents.find((event) => event.toolName === "cmd");
    expect(completedToolEvent).toMatchObject({
      title: "명령 실행",
      detail: "cmd /c echo hello cmd /c echo world",
      status: "done",
    });
  });

  it("stores shell ui preferences in state", () => {
    const themed = appReducer(initialAppState, { type: "set_theme", themeId: "dark" });
    const collapsed = appReducer(themed, { type: "set_sidebar_collapsed", value: true, source: "manual" });

    expect(collapsed.themeId).toBe("dark");
    expect(collapsed.sidebarCollapsed).toBe(true);
  });

  it("tracks automatic and manual sidebar collapse reasons", () => {
    const autoCollapsed = appReducer(initialAppState, { type: "set_sidebar_collapsed", value: true, source: "auto" });
    const manualCollapsed = appReducer(initialAppState, { type: "set_sidebar_collapsed", value: true, source: "manual" });
    const reopened = appReducer(manualCollapsed, { type: "set_sidebar_collapsed", value: false, source: "manual" });

    expect(autoCollapsed.sidebarCollapsed).toBe(true);
    expect(autoCollapsed.sidebarCollapseReason).toBe("auto");
    expect(manualCollapsed.sidebarCollapsed).toBe(true);
    expect(manualCollapsed.sidebarCollapseReason).toBe("manual");
    expect(reopened.sidebarCollapsed).toBe(false);
    expect(reopened.sidebarCollapseReason).toBe("manual");

    const released = appReducer(reopened, { type: "release_sidebar_manual_open" });
    expect(released.sidebarCollapsed).toBe(false);
    expect(released.sidebarCollapseReason).toBeNull();
  });

  it("closes the runtime picker when the sidebar collapses", () => {
    const openPicker = {
      ...initialAppState,
      runtimePicker: { ...initialAppState.runtimePicker, open: true, loading: true, error: "failed" },
    };
    const collapsed = appReducer(openPicker, { type: "set_sidebar_collapsed", value: true, source: "manual" });

    expect(collapsed.sidebarCollapsed).toBe(true);
    expect(collapsed.sidebarCollapseReason).toBe("manual");
    expect(collapsed.runtimePicker.open).toBe(false);
    expect(collapsed.runtimePicker.loading).toBe(false);
    expect(collapsed.runtimePicker.error).toBe("");
  });

  it("keeps artifact list and preview widths independent", () => {
    const base = {
      ...initialAppState,
      artifactPanelListWidth: 360,
      artifactPanelPreviewWidth: 720,
      artifactPanelWidth: 360,
    };

    const listOpen = appReducer(base, { type: "open_artifact_list" });
    expect(listOpen.artifactPanelWidth).toBe(360);

    const resizedList = appReducer(listOpen, { type: "set_artifact_panel_width", value: 400 });
    expect(resizedList.artifactPanelListWidth).toBe(400);
    expect(resizedList.artifactPanelPreviewWidth).toBe(720);

    const previewOpen = appReducer(resizedList, {
      type: "open_artifact",
      artifact: { path: "outputs/report.html", name: "report.html", kind: "html" },
    });
    expect(previewOpen.artifactPanelWidth).toBe(720);

    const resizedPreview = appReducer(previewOpen, { type: "set_artifact_panel_width", value: 760 });
    expect(resizedPreview.artifactPanelListWidth).toBe(400);
    expect(resizedPreview.artifactPanelPreviewWidth).toBe(760);

    const listAgain = appReducer(resizedPreview, { type: "open_artifact_list" });
    expect(listAgain.artifactPanelWidth).toBe(400);
  });
});
