import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChangeEvent, ClipboardEvent, FormEvent, KeyboardEvent, MouseEvent } from "react";
import { cancelMessage, sendMessage, uploadClientAttachments } from "../api/messages";
import type { ClientAttachmentRef, ComposeOptions } from "../api/messages";
import { startSession } from "../api/session";
import { messageBottomFollowEvent } from "../hooks/useMessageAutoFollow";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary, Attachment, CommandItem, McpServerItem, SkillItem } from "../types/backend";
import { artifactDisplayName } from "../utils/artifacts";
import { runtimePreferencesFromState } from "../utils/runtimePreferences";
import { InlineQuestion } from "./InlineQuestion";
import { TodoDock } from "./TodoDock";

const longPastedTextLineThreshold = 20;
const maxImageBytes = 10 * 1024 * 1024;
const outputTokenPresets = {
  long: 10_000,
  very_long: 12_000,
  extended: 16_000,
} as const;
const extraLongTokenOptions = [24_000, 32_000, 40_000] as const;

type OutputSurface = "default" | "chat" | "artifact";
type ArtifactAction = "auto" | "create" | "edit";
type LengthPreset = "default" | "long" | "very_long" | "extended" | "extra_long";
type UploadedClientAttachment = ClientAttachmentRef & { previewUrl?: string };

type Suggestion =
  | { kind: "command"; value: string; label: string; description: string }
  | { kind: "skill"; value: string; label: string; description: string }
  | { kind: "mcp"; value: string; label: string; description: string }
  | { kind: "file"; value: string; label: string; description: string };

type ActiveSuggestionToken = {
  trigger: "/" | "$" | "@";
  query: string;
  start: number;
  end: number;
};

function fileToAttachment(file: File): Promise<Attachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`${file.name || "이미지"}를 읽지 못했습니다.`));
    reader.onload = () => {
      const result = String(reader.result || "");
      const [, data = ""] = result.split(",", 2);
      resolve({
        media_type: file.type || "image/png",
        data,
        name: file.name || "pasted-image.png",
      });
    };
    reader.readAsDataURL(file);
  });
}

function visibleAttachmentNames(attachments: Attachment[], attachmentRefs: ClientAttachmentRef[] = []) {
  return [
    ...attachments.map((attachment, index) => attachment.name || `이미지 ${index + 1}`),
    ...attachmentRefs.map((attachment, index) => attachment.name || `파일 ${index + 1}`),
  ]
    .filter(Boolean)
    .map((name) => `[${name}]`)
    .join(" ");
}

function visibleUserMessageText(line: string, attachments: Attachment[], attachmentRefs: ClientAttachmentRef[] = []) {
  const attachmentNames = visibleAttachmentNames(attachments, attachmentRefs);
  if (!attachmentNames) {
    return line;
  }
  return [line, attachmentNames].filter(Boolean).join("\n");
}

function formatFileSize(bytes: number) {
  const value = Number(bytes);
  if (!Number.isFinite(value) || value <= 0) return "";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function fileTypeLabel(attachment: ClientAttachmentRef) {
  const name = attachment.name || "";
  const extension = name.includes(".") ? name.split(".").pop()?.toUpperCase() : "";
  if (extension) return extension;
  const mediaType = attachment.media_type || "";
  return mediaType.includes("/") ? mediaType.split("/").pop()?.toUpperCase() || "FILE" : "FILE";
}

function isImageRef(attachment: ClientAttachmentRef) {
  return String(attachment.media_type || "").toLowerCase().startsWith("image/");
}

function commandSuggestions(commands: CommandItem[], query: string): Suggestion[] {
  const normalized = query.replace(/^\//, "").toLowerCase();
  return commands
    .filter((command) => command.name.toLowerCase().includes(normalized))
    .slice(0, 8)
    .map((command) => ({
      kind: "command",
      value: command.name.startsWith("/") ? command.name : `/${command.name}`,
      label: command.name.startsWith("/") ? command.name : `/${command.name}`,
      description: command.description || "명령 실행",
    }));
}

function skillSuggestions(skills: SkillItem[], query: string): Suggestion[] {
  const normalized = query.replace(/^\$/, "").toLowerCase();
  return skills
    .filter((skill) => skill.enabled !== false && skill.name.toLowerCase().includes(normalized))
    .map((skill) => ({
      kind: "skill",
      value: `$${skill.name}`,
      label: `$${skill.name}`,
      description: skill.description || skill.source || "스킬",
    }));
}

function mcpSuggestions(servers: McpServerItem[], query: string): Suggestion[] {
  const normalized = query.replace(/^\$/, "").replace(/^mcp:/i, "").toLowerCase();
  return servers
    .filter((server) => server.state !== "disabled" && server.name.toLowerCase().includes(normalized))
    .map((server) => {
      const details = [
        server.state || "configured",
        server.transport,
        Number.isFinite(server.tool_count) ? `도구 ${server.tool_count}` : "",
        Number.isFinite(server.resource_count) ? `리소스 ${server.resource_count}` : "",
      ].filter(Boolean);
      return {
        kind: "mcp",
        value: `$mcp:${server.name}`,
        label: `$mcp:${server.name}`,
        description: details.join(" · ") || server.detail || "MCP 서버",
      };
    });
}

function fileSuggestions(artifacts: ArtifactSummary[], query: string): Suggestion[] {
  const normalized = query.replace(/^@/, "").toLowerCase();
  return artifacts
    .filter((artifact) => {
      const displayName = artifactDisplayName(artifact);
      return artifact.path.toLowerCase().includes(normalized) || displayName.toLowerCase().includes(normalized);
    })
    .slice(0, 8)
    .map((artifact) => {
      const displayName = artifactDisplayName(artifact);
      return {
        kind: "file",
        value: `@${artifact.path}`,
        label: `@${displayName}`,
        description: artifact.path,
      };
    });
}

function activeSuggestionToken(value: string, cursorOffset: number): ActiveSuggestionToken | null {
  const end = Math.max(0, Math.min(cursorOffset, value.length));
  const beforeCursor = value.slice(0, end);
  const tokenStart = Math.max(beforeCursor.lastIndexOf(" "), beforeCursor.lastIndexOf("\n"), beforeCursor.lastIndexOf("\t")) + 1;
  const query = beforeCursor.slice(tokenStart);

  if (!query) return null;
  if (query.startsWith("$")) return { trigger: "$", query, start: tokenStart, end };
  if (query.startsWith("@")) return { trigger: "@", query, start: tokenStart, end };
  if (query.startsWith("/") && value.slice(0, tokenStart).trim() === "") {
    return { trigger: "/", query, start: tokenStart, end };
  }
  return null;
}

export function Composer() {
  const { state, dispatch } = useAppState();
  const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
  const [isMultiline, setIsMultiline] = useState(false);
  const [cursorOffset, setCursorOffset] = useState(0);
  const [expandedPanelOpen, setExpandedPanelOpen] = useState(false);
  const [uploadedAttachments, setUploadedAttachments] = useState<UploadedClientAttachment[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [outputSurface, setOutputSurface] = useState<OutputSurface>("default");
  const [artifactAction, setArtifactAction] = useState<ArtifactAction>("auto");
  const [lengthPreset, setLengthPreset] = useState<LengthPreset>("default");
  const [extraLongTarget, setExtraLongTarget] = useState<number>(24_000);
  const composerRef = useRef<HTMLFormElement | null>(null);
  const composerBoxRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const clientFileInputRef = useRef<HTMLInputElement | null>(null);
  const activeSuggestionRef = useRef<HTMLButtonElement | null>(null);
  const uploadedAttachmentsRef = useRef<UploadedClientAttachment[]>([]);
  const composerHeightRef = useRef(0);
  const composerMetricFrameRef = useRef(0);
  const composerFollowFrameRef = useRef(0);
  const chatPanelMetricFrameRef = useRef(0);
  const submittingRef = useRef(false);
  const draft = state.composer.draft;
  const hasPayload = Boolean(draft.trim() || state.composer.attachments.length || uploadedAttachments.length || state.composer.pastedTexts.length);
  const hasAnyAttachment = Boolean(state.composer.attachments.length || uploadedAttachments.length);
  const canSend = Boolean(state.sessionId && hasPayload && !state.busy && !uploadingFiles);
  const canSteer = Boolean(state.sessionId && state.busy && fullLine().trim() && !hasAnyAttachment);
  const showStop = Boolean(state.busy && !canSteer);
  const suggestionToken = useMemo(() => activeSuggestionToken(draft, cursorOffset), [draft, cursorOffset]);
  const suggestions = useMemo(() => {
    if (!suggestionToken) return [];
    if (suggestionToken.trigger === "/") return commandSuggestions(state.commands, suggestionToken.query);
    if (suggestionToken.trigger === "$") {
      return [
        ...skillSuggestions(state.skills, suggestionToken.query),
        ...mcpSuggestions(state.mcpServers, suggestionToken.query),
      ];
    }
    if (suggestionToken.trigger === "@") return fileSuggestions(state.artifacts, suggestionToken.query);
    return [];
  }, [state.artifacts, state.commands, state.mcpServers, state.skills, suggestionToken]);
  const activeSuggestionIndex = suggestions.length ? Math.min(selectedSuggestionIndex, suggestions.length - 1) : 0;

  useEffect(() => {
    setSelectedSuggestionIndex(0);
  }, [draft]);

  useEffect(() => {
    if (!state.busy) {
      submittingRef.current = false;
    }
  }, [state.busy]);

  useEffect(() => {
    uploadedAttachmentsRef.current = uploadedAttachments;
  }, [uploadedAttachments]);

  useEffect(() => () => {
    for (const attachment of uploadedAttachmentsRef.current) {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
  }, []);

  useEffect(() => {
    resetExpandedPanel({ keepOpen: false });
  }, [state.activeHistoryId]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      setCursorOffset(draft.length);
      return;
    }
    setCursorOffset(document.activeElement === input ? input.selectionStart ?? draft.length : draft.length);
  }, [draft]);

  useEffect(() => {
    activeSuggestionRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [activeSuggestionIndex, suggestions.length]);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;

    const style = window.getComputedStyle(input);
    const maxHeight = Number.parseFloat(style.getPropertyValue("--composer-input-max-height")) || 96;
    const minHeight = Number.parseFloat(style.minHeight) || 20;

    input.style.height = "auto";
    const nextHeight = Math.min(maxHeight, Math.max(minHeight, input.scrollHeight));
    input.style.height = `${nextHeight}px`;
    input.style.overflowY = input.scrollHeight > maxHeight + 1 ? "auto" : "hidden";
    setIsMultiline(nextHeight > minHeight + 12);
  }, [draft, state.composer.attachments.length, state.composer.pastedTexts.length]);

  useLayoutEffect(() => {
    function messagesContainer() {
      const chatPanel = composerRef.current?.closest(".chat-panel");
      return chatPanel?.querySelector<HTMLElement>(".messages") ?? document.querySelector<HTMLElement>(".messages");
    }

    function updateComposerStackHeight() {
      const composerRect = composerRef.current?.getBoundingClientRect();
      const height = composerRect && Number.isFinite(composerRect.top)
        ? Math.ceil(Math.max(0, composerRect.bottom - composerRect.top))
        : Math.ceil(composerRef.current?.getBoundingClientRect().height || 0);
      const messages = messagesContainer();
      const remaining = messages
        ? messages.scrollHeight - messages.clientHeight - messages.scrollTop
        : Number.POSITIVE_INFINITY;
      const wasFollowingTail = Boolean(messages && (
        messages.classList.contains("streaming-follow") || remaining <= 160
      ));
      const previousHeight = composerHeightRef.current;
      const heightChanged = previousHeight > 0 && height > 0 && Math.abs(height - previousHeight) > 1;
      if (height > 0) {
        document.documentElement.style.setProperty("--composer-stack-height", `${height}px`);
        composerHeightRef.current = height;
      }

      if (heightChanged && wasFollowingTail && !composerFollowFrameRef.current) {
        composerFollowFrameRef.current = window.requestAnimationFrame(() => {
          composerFollowFrameRef.current = 0;
          window.dispatchEvent(new Event(messageBottomFollowEvent));
        });
      }
    }

    function scheduleComposerStackHeightUpdate() {
      if (composerMetricFrameRef.current) {
        window.cancelAnimationFrame(composerMetricFrameRef.current);
      }
      composerMetricFrameRef.current = window.requestAnimationFrame(() => {
        composerMetricFrameRef.current = 0;
        updateComposerStackHeight();
      });
    }

    updateComposerStackHeight();
    if (!window.ResizeObserver) return;

    const observer = new ResizeObserver(scheduleComposerStackHeightUpdate);
    if (composerRef.current) observer.observe(composerRef.current);
    if (composerBoxRef.current) observer.observe(composerBoxRef.current);
    return () => {
      observer.disconnect();
      if (composerMetricFrameRef.current) {
        window.cancelAnimationFrame(composerMetricFrameRef.current);
        composerMetricFrameRef.current = 0;
      }
      if (composerFollowFrameRef.current) {
        window.cancelAnimationFrame(composerFollowFrameRef.current);
        composerFollowFrameRef.current = 0;
      }
    };
  }, [
    expandedPanelOpen,
    isMultiline,
    lengthPreset,
    state.composer.attachments.length,
    state.composer.pastedTexts.length,
    state.todoCollapsed,
    state.todoMarkdown,
    uploadedAttachments.length,
  ]);

  useLayoutEffect(() => {
    function updateChatPanelMetrics() {
      const rect = composerRef.current?.closest(".chat-panel")?.getBoundingClientRect();
      if (!rect) {
        return;
      }
      document.documentElement.style.setProperty("--chat-panel-left", `${Math.round(rect.left)}px`);
      document.documentElement.style.setProperty("--chat-panel-width", `${Math.round(rect.width)}px`);
    }

    function scheduleChatPanelMetricsUpdate() {
      if (chatPanelMetricFrameRef.current) {
        window.cancelAnimationFrame(chatPanelMetricFrameRef.current);
      }
      chatPanelMetricFrameRef.current = window.requestAnimationFrame(() => {
        chatPanelMetricFrameRef.current = 0;
        updateChatPanelMetrics();
      });
    }

    updateChatPanelMetrics();
    scheduleChatPanelMetricsUpdate();
    if (!window.ResizeObserver) return;

    const chatPanel = composerRef.current?.closest(".chat-panel");
    if (!chatPanel) {
      return () => {
        if (chatPanelMetricFrameRef.current) {
          window.cancelAnimationFrame(chatPanelMetricFrameRef.current);
          chatPanelMetricFrameRef.current = 0;
        }
      };
    }

    const observer = new ResizeObserver(scheduleChatPanelMetricsUpdate);
    observer.observe(chatPanel);
    return () => {
      observer.disconnect();
      if (chatPanelMetricFrameRef.current) {
        window.cancelAnimationFrame(chatPanelMetricFrameRef.current);
        chatPanelMetricFrameRef.current = 0;
      }
    };
  }, [state.artifactPanelOpen]);

  function fullLine() {
    const pasted = state.composer.pastedTexts.map((text, index) => `[붙여넣은 텍스트 ${index + 1}]\n${text}`).join("\n\n");
    return [draft.trim(), pasted].filter(Boolean).join("\n\n");
  }

  function resetExpandedPanel(options: { keepOpen?: boolean } = {}) {
    for (const attachment of uploadedAttachments) {
      if (attachment.previewUrl) {
        URL.revokeObjectURL(attachment.previewUrl);
      }
    }
    setUploadedAttachments([]);
    setUploadingFiles(false);
    setOutputSurface("default");
    setArtifactAction("auto");
    setLengthPreset("default");
    setExtraLongTarget(24_000);
    if (!options.keepOpen) {
      setExpandedPanelOpen(false);
    }
  }

  function toggleExpandedPanel() {
    if (expandedPanelOpen) {
      resetExpandedPanel();
      return;
    }
    setExpandedPanelOpen(true);
  }

  function resolvedTargetOutputTokens() {
    if (lengthPreset === "extra_long") {
      return extraLongTarget;
    }
    if (lengthPreset === "default") {
      return undefined;
    }
    return outputTokenPresets[lengthPreset];
  }

  function composeOptionsPayload(): ComposeOptions | undefined {
    const options: ComposeOptions = {};
    if (outputSurface !== "default") {
      options.output_surface = outputSurface;
    }
    if (outputSurface !== "chat") {
      if (outputSurface === "artifact" || artifactAction !== "auto") {
        options.artifact_action = artifactAction;
      }
      if (lengthPreset !== "default") {
        const targetOutputTokens = resolvedTargetOutputTokens();
        options.length_preset = lengthPreset;
        if (targetOutputTokens !== undefined) {
          options.target_output_tokens = targetOutputTokens;
        }
      }
      if (artifactAction === "edit" && state.activeArtifact?.path) {
        options.active_artifact_path = state.activeArtifact.path;
      }
    }
    return Object.keys(options).length ? options : undefined;
  }

  async function handleClientFileInput(event: ChangeEvent<HTMLInputElement>) {
    const files = [...(event.currentTarget.files || [])];
    event.currentTarget.value = "";
    if (!files.length) return;
    setUploadingFiles(true);
    try {
      const previews = new Map<string, string>();
      for (const file of files) {
        if (file.type.startsWith("image/")) {
          previews.set(`${file.name}\u0000${file.size}\u0000${file.lastModified}`, URL.createObjectURL(file));
        }
      }
      const result = await uploadClientAttachments({
        sessionId: state.sessionId,
        clientId: state.clientId,
        workspacePath: state.workspacePath || undefined,
        workspaceName: state.workspaceName || undefined,
        files,
      });
      const nextAttachments = result.attachments.map((attachment, index) => {
        const source = files[index];
        const previewUrl = source
          ? previews.get(`${source.name}\u0000${source.size}\u0000${source.lastModified}`)
          : undefined;
        return previewUrl ? { ...attachment, previewUrl } : attachment;
      });
      setUploadedAttachments((current) => [...current, ...nextAttachments]);
      setExpandedPanelOpen(true);
    } catch (error) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    } finally {
      setUploadingFiles(false);
    }
  }

  function removeUploadedAttachment(index: number) {
    setUploadedAttachments((current) => {
      const target = current[index];
      if (target?.previewUrl) {
        URL.revokeObjectURL(target.previewUrl);
      }
      return current.filter((_, itemIndex) => itemIndex !== index);
    });
  }

  async function addImageFile(file: File) {
    if (!file.type.startsWith("image/")) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: "이미지 파일만 첨부할 수 있습니다." } });
      return;
    }
    if (file.size > maxImageBytes) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: "이미지는 10MB 이하만 첨부할 수 있습니다." } });
      return;
    }
    try {
      dispatch({ type: "add_attachment", attachment: await fileToAttachment(file) });
    } catch (error) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  function attachmentSrc(attachment: Attachment) {
    return `data:${attachment.media_type || "image/png"};base64,${attachment.data}`;
  }

  function showAttachmentPreview(attachment: Attachment) {
    dispatch({
      type: "open_modal",
      modal: {
        kind: "imagePreview",
        src: attachmentSrc(attachment),
        name: attachment.name || "이미지",
        alt: attachment.name || "첨부 이미지",
      },
    });
  }

  function showUploadedAttachmentPreview(attachment: UploadedClientAttachment) {
    if (!attachment.previewUrl) return;
    dispatch({
      type: "open_modal",
      modal: {
        kind: "imagePreview",
        src: attachment.previewUrl,
        name: attachment.name || "첨부 이미지",
        alt: attachment.name || "첨부 이미지",
      },
    });
  }

  function applySuggestion(suggestion: Suggestion) {
    if (!suggestionToken) {
      dispatch({ type: "set_draft", value: suggestion.value });
      return;
    }

    const input = inputRef.current;
    const replaceEnd = Math.max(suggestionToken.end, input?.selectionEnd ?? suggestionToken.end);
    const suffix = draft.slice(replaceEnd);
    const shouldSeparateMention = suggestionToken.trigger === "@" || suggestionToken.trigger === "$";
    const spacer = shouldSeparateMention && !suffix.startsWith(" ") ? " " : "";
    const cursorSpacerOffset = shouldSeparateMention && suffix.startsWith(" ") ? 1 : spacer.length;
    const nextDraft = `${draft.slice(0, suggestionToken.start)}${suggestion.value}${spacer}${suffix}`;
    const nextCursorOffset = suggestionToken.start + suggestion.value.length + cursorSpacerOffset;
    dispatch({ type: "set_draft", value: nextDraft });
    window.requestAnimationFrame(() => {
      const nextInput = inputRef.current;
      nextInput?.focus();
      nextInput?.setSelectionRange(nextCursorOffset, nextCursorOffset);
      setCursorOffset(nextCursorOffset);
    });
  }

  function syncCursorFromInput(input: HTMLTextAreaElement) {
    setCursorOffset(input.selectionStart ?? input.value.length);
  }

  function requestMessageBottomFollow() {
    window.dispatchEvent(new Event(messageBottomFollowEvent));
  }

  async function cancelCurrent() {
    if (!state.sessionId) return;
    try {
      await cancelMessage(state.sessionId, state.clientId);
      dispatch({ type: "set_busy", value: false });
    } catch (error) {
      dispatch({ type: "open_modal", modal: { kind: "error", message: error instanceof Error ? error.message : String(error) } });
    }
  }

  async function togglePlanMode() {
    if (!state.sessionId) return;
    const currentDraft = state.composer.draft;
    const previousPermissionMode = state.permissionMode;
    const nextPermissionMode = isPlanMode(previousPermissionMode) ? "full_auto" : "plan";
    dispatch({ type: "set_permission_mode", value: nextPermissionMode });
    try {
      await sendMessage({
        sessionId: state.sessionId,
        clientId: state.clientId,
        line: "/plan",
        attachments: [],
        suppressUserTranscript: true,
      });
      dispatch({ type: "set_draft", value: currentDraft });
    } catch (error) {
      dispatch({ type: "set_permission_mode", value: previousPermissionMode });
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      submittingRef.current = false;
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (state.busy) {
      if (canSteer) {
        await sendBusyLine("steer");
        return;
      }
      if (!hasPayload) {
        await cancelCurrent();
      }
      return;
    }
    if (submittingRef.current) {
      return;
    }
    const line = fullLine();
    if (!state.sessionId || !line && !hasAnyAttachment) {
      return;
    }

    submittingRef.current = true;
    const shellShortcut = line.trim().startsWith("!") && !hasAnyAttachment;
    const attachments = state.composer.attachments;
    const attachmentRefs = uploadedAttachments;
    const composeOptions = composeOptionsPayload();
    const visibleText = visibleUserMessageText(line, attachments, attachmentRefs);
    let targetSessionId = state.sessionId;
    const userMessage = shellShortcut
      ? {
          role: "log" as const,
          text: line,
          toolName: "shell-shortcut",
          terminal: { command: line.trim().slice(1).trim(), status: "running" as const },
        }
      : { role: "user" as const, text: visibleText || "(파일 첨부)" };
    dispatch({ type: "set_busy", value: true });
    dispatch({ type: "append_message", message: userMessage, skipHistory: state.pendingFreshChat });
    dispatch({ type: "clear_composer" });
    resetExpandedPanel();

    try {
      if (state.pendingFreshChat) {
        const session = await startSession({
          clientId: state.clientId,
          cwd: state.workspacePath || undefined,
          ...runtimePreferencesFromState(state),
        });
        targetSessionId = session.sessionId;
        dispatch({
          type: "session_started",
          sessionId: session.sessionId,
          clientId: state.clientId,
        });
        if (session.workspace) {
          dispatch({ type: "set_workspace", workspace: session.workspace });
        }
      }
      await sendMessage({
        sessionId: targetSessionId,
        clientId: state.clientId,
        line,
        attachments,
        attachmentRefs: attachmentRefs.length ? attachmentRefs : undefined,
        composeOptions,
        suppressUserTranscript: true,
        systemPrompt: state.systemPrompt.trim() || undefined,
      });
    } catch (error) {
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function sendBusyLine(mode: "queue" | "steer") {
    if (!state.sessionId) return;
    const line = fullLine();
    if (!line && !hasAnyAttachment) {
      await cancelCurrent();
      return;
    }
    if (hasAnyAttachment) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: "진행 중인 답변에는 텍스트만 보낼 수 있습니다. 첨부파일은 답변이 끝난 뒤 보내주세요." },
      });
      return;
    }
    dispatch({
      type: "append_message",
      message: {
        role: "user",
        text: line,
        kind: mode === "queue" ? "queued" : "steering",
      },
    });
    dispatch({ type: "clear_composer" });
    try {
      await sendMessage({
        sessionId: state.sessionId,
        clientId: state.clientId,
        line,
        attachments: [],
        mode,
      });
    } catch (error) {
      dispatch({
        type: "backend_event",
        event: { type: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Tab" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) {
      event.preventDefault();
      if (!state.busy) {
        void togglePlanMode();
      }
      return;
    }
    if (suggestions.length && (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Tab" || event.key === "Escape")) {
      event.preventDefault();
      if (event.key === "Escape") {
        setSelectedSuggestionIndex(0);
        return;
      }
      if (event.key === "ArrowDown") {
        setSelectedSuggestionIndex((index) => (index + 1) % suggestions.length);
        return;
      }
      if (event.key === "ArrowUp") {
        setSelectedSuggestionIndex((index) => (index - 1 + suggestions.length) % suggestions.length);
        return;
      }
      applySuggestion(suggestions[activeSuggestionIndex]);
      return;
    }
    if (event.key === "Enter" && event.ctrlKey && !event.shiftKey) {
      event.preventDefault();
      if (state.busy) {
        if (hasPayload) {
          requestMessageBottomFollow();
        }
        void sendBusyLine("queue");
        return;
      }
      if (hasPayload) {
        requestMessageBottomFollow();
      }
      event.currentTarget.form?.requestSubmit();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (suggestions[activeSuggestionIndex]) {
        applySuggestion(suggestions[activeSuggestionIndex]);
        return;
      }
      if (state.busy) {
        if (hasPayload) {
          requestMessageBottomFollow();
        }
        void sendBusyLine("steer");
        return;
      }
      if (hasPayload) {
        requestMessageBottomFollow();
      }
      event.currentTarget.form?.requestSubmit();
    }
  }

  function handleComposerBoxMouseDown(event: MouseEvent<HTMLDivElement>) {
    if (event.target === event.currentTarget) {
      inputRef.current?.focus();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const items = [...event.clipboardData.items];
    const imageItem = items.find((item) => item.kind === "file" && item.type.startsWith("image/"));
    if (imageItem) {
      const file = imageItem.getAsFile();
      if (file) {
        event.preventDefault();
        void addImageFile(file);
        return;
      }
    }
    const text = event.clipboardData.getData("text/plain");
    if (text && text.split(/\r?\n/).length > longPastedTextLineThreshold) {
      event.preventDefault();
      dispatch({ type: "add_pasted_text", text });
    }
  }

  return (
    <form className="composer" id="composer" ref={composerRef} onSubmit={handleSubmit}>
      <TodoDock variant="dock" />
      <div className={`pasted-text-tray${state.composer.pastedTexts.length ? "" : " hidden"}`} id="pastedTextTray" aria-label="붙여넣은 텍스트">
        {state.composer.pastedTexts.map((text, index) => (
          <div className="pasted-text-chip" key={`${text.length}-${index}`}>
            <span>[붙여넣은 텍스트 #{index + 1} +{text.replace(/\r\n/g, "\n").split("\n").length}줄]</span>
            <button className="pasted-text-remove" type="button" aria-label="붙여넣은 텍스트 삭제" onClick={() => dispatch({ type: "remove_pasted_text", index })}>
              x
            </button>
          </div>
        ))}
      </div>
      <InlineQuestion />
      {expandedPanelOpen ? (
        <>
          <input
            ref={clientFileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            aria-hidden="true"
            tabIndex={-1}
            onChange={handleClientFileInput}
          />
          {uploadedAttachments.length ? (
            <div className="composer-attachment-row" aria-label="첨부한 파일">
              {uploadedAttachments.map((attachment, index) => (
                <div className="client-attachment-chip" key={`${attachment.id}-${index}`}>
                  {isImageRef(attachment) && attachment.previewUrl ? (
                    <img
                      src={attachment.previewUrl}
                      alt={attachment.name || "첨부 이미지"}
                      role="button"
                      tabIndex={0}
                      onClick={() => showUploadedAttachmentPreview(attachment)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          showUploadedAttachmentPreview(attachment);
                        }
                      }}
                    />
                  ) : (
                    <span className="client-attachment-type">{fileTypeLabel(attachment)}</span>
                  )}
                  <span className="client-attachment-name">{attachment.name || "첨부 파일"}</span>
                  <small>{formatFileSize(attachment.size)}</small>
                  <button className="client-attachment-remove" type="button" aria-label={`${attachment.name || "첨부 파일"} 삭제`} onClick={() => removeUploadedAttachment(index)}>
                    x
                  </button>
                </div>
              ))}
            </div>
          ) : null}
          <div className="composer-control-panel" aria-label="입력 옵션" data-tooltip-top-boundary="true">
            <div className="composer-panel-controls">
              <div className="composer-control-group composer-attach-group">
                <button
                  className="composer-panel-attach"
                  type="button"
                  aria-label={uploadingFiles ? "파일첨부 중" : "파일첨부"}
                  data-tooltip="파일첨부"
                  data-tooltip-placement="top"
                  onClick={() => clientFileInputRef.current?.click()}
                  disabled={uploadingFiles}
                >
                  <svg aria-hidden="true" viewBox="0 0 24 24">
                    <path d="m21.4 11.1-8.9 8.9a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 1 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5" />
                  </svg>
                </button>
              </div>
              <div className="composer-control-group">
                <span
                  className="composer-control-label"
                  data-tooltip="답변을 채팅에 표시할지 파일로 만들지 정합니다. 자동은 요청에 맞춰 판단합니다."
                  data-tooltip-placement="top"
                >
                  출력
                </span>
                <div className="composer-segment" aria-label="출력 위치">
                  {([
                    ["default", "자동"],
                    ["chat", "채팅"],
                    ["artifact", "파일"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={outputSurface === value ? "active" : ""}
                      aria-pressed={outputSurface === value}
                      onClick={() => setOutputSurface(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="composer-control-group">
                <span
                  className="composer-control-label"
                  data-tooltip="파일을 만들 때 새로 생성할지 기존 파일을 수정할지 정합니다."
                  data-tooltip-placement="top"
                >
                  모드
                </span>
                <div className="composer-segment" aria-label="파일 작업">
                  {([
                    ["auto", "자동"],
                    ["create", "생성"],
                    ["edit", "수정"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={artifactAction === value ? "active" : ""}
                      aria-pressed={artifactAction === value}
                      onClick={() => setArtifactAction(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="composer-control-group">
                <span
                  className="composer-control-label"
                  data-tooltip="파일 생성 시 목표 분량입니다. 단위는 출력 토큰이며, 채팅 답변 길이에는 적용하지 않습니다."
                  data-tooltip-placement="top"
                >
                  출력량
                </span>
                <div className="composer-segment composer-length-segment" aria-label="출력 길이">
                  {([
                    ["default", "자동"],
                    ["long", "10k"],
                    ["very_long", "12k"],
                    ["extended", "16k"],
                  ] as const).map(([value, label]) => (
                    <button
                      key={value}
                      type="button"
                      className={lengthPreset === value ? "active" : ""}
                      aria-pressed={lengthPreset === value}
                      onClick={() => setLengthPreset(value)}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="composer-length-divider" aria-hidden="true" />
                  {extraLongTokenOptions.map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`danger${lengthPreset === "extra_long" && extraLongTarget === value ? " active" : ""}`}
                      aria-pressed={lengthPreset === "extra_long" && extraLongTarget === value}
                      onClick={() => {
                        setLengthPreset("extra_long");
                        setExtraLongTarget(value);
                      }}
                    >
                      ~{value / 1000}k
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </>
      ) : null}
      <div className={`composer-box${isMultiline ? " multiline" : ""}${expandedPanelOpen ? " with-panel" : ""}`} ref={composerBoxRef} onMouseDown={handleComposerBoxMouseDown}>
        <div className={`attachment-tray${state.composer.attachments.length ? "" : " hidden"}`} id="attachmentTray" aria-label="첨부한 이미지">
          {state.composer.attachments.map((attachment, index) => (
            <div className="attachment-chip" key={`${attachment.name}-${index}`}>
              <img
                src={attachmentSrc(attachment)}
                alt={attachment.name || "첨부 이미지"}
                role="button"
                tabIndex={0}
                onClick={() => showAttachmentPreview(attachment)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    showAttachmentPreview(attachment);
                  }
                }}
              />
              <span onClick={() => showAttachmentPreview(attachment)}>{attachment.name || "이미지"}</span>
              <button className="attachment-remove" type="button" aria-label="첨부 이미지 삭제" onClick={() => dispatch({ type: "remove_attachment", index })}>
                x
              </button>
            </div>
          ))}
        </div>
        <button
          className={`composer-expand-button${expandedPanelOpen ? " active" : ""}`}
          type="button"
          aria-label={expandedPanelOpen ? "입력 옵션 닫기" : "입력 옵션 열기"}
          aria-expanded={expandedPanelOpen}
          onClick={toggleExpandedPanel}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
        <textarea
          id="promptInput"
          ref={inputRef}
          rows={1}
          placeholder="메시지를 입력하세요..."
          autoComplete="off"
          spellCheck={false}
          value={draft}
          onChange={(event) => {
            syncCursorFromInput(event.currentTarget);
            dispatch({ type: "set_draft", value: event.currentTarget.value });
          }}
          onClick={(event) => syncCursorFromInput(event.currentTarget)}
          onKeyDown={handleKeyDown}
          onKeyUp={(event) => syncCursorFromInput(event.currentTarget)}
          onPaste={handlePaste}
          onSelect={(event) => syncCursorFromInput(event.currentTarget)}
        />
        <button
          className={`plan-mode-indicator${isPlanMode(state.permissionMode) ? "" : " hidden"}`}
          type="button"
          aria-label="계획모드 전환"
          aria-pressed={isPlanMode(state.permissionMode)}
          onClick={() => void togglePlanMode()}
        >
          <svg aria-hidden="true" viewBox="0 0 24 24">
            <path d="M9 6h11" />
            <path d="M9 12h11" />
            <path d="M9 18h11" />
            <path d="M4 6h.01" />
            <path d="M4 12h.01" />
            <path d="M4 18h.01" />
          </svg>
          <span>계획모드</span>
        </button>
        <TodoDock variant="composerButton" />
        <button
          id="sendButton"
          className={showStop ? "is-stop" : canSteer ? "is-steer" : ""}
          type="submit"
          disabled={state.busy ? !showStop && !canSteer : !canSend}
          aria-label={showStop ? "작업 중단" : canSteer ? "스티어링 보내기" : "메시지 보내기"}
        >
          {showStop ? (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="8.5" />
              <path d="M15.5 8.5 8.5 15.5" />
              <path d="m8.5 8.5 7 7" />
            </svg>
          ) : (
            <svg aria-hidden="true" viewBox="0 0 24 24">
              <path d="m22 2-7 20-4-9-9-4Z" />
              <path d="M22 2 11 13" />
            </svg>
          )}
        </button>
      </div>
      <div className={`slash-menu${suggestions.length ? "" : " hidden"}`} id="slashMenu" role="listbox" aria-label="명령어와 스킬">
        {suggestions.map((suggestion, index) => (
          <button
            className={`slash-menu-item${index === activeSuggestionIndex ? " active" : ""}`}
            type="button"
            role="option"
            aria-selected={index === activeSuggestionIndex}
            key={`${suggestion.kind}-${suggestion.value}`}
            ref={index === activeSuggestionIndex ? activeSuggestionRef : null}
            onClick={() => applySuggestion(suggestion)}
          >
            <span className="slash-command-name">{suggestion.label}</span>
            <span className="slash-command-description">{suggestion.description}</span>
          </button>
        ))}
      </div>
    </form>
  );
}

function isPlanMode(value: string) {
  const mode = String(value || "").trim().toLowerCase().replace(/\s+/g, "_");
  return mode === "plan" || mode === "plan_mode" || mode === "permissionmode.plan";
}
