import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { aiEditArtifact, deleteArtifact, listProjectFiles, organizeProjectFiles, overwriteArtifact, readArtifact, renameArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary } from "../types/backend";
import type { ArtifactAiEditComment, ArtifactAiEditSelection, WorkflowEvent } from "../types/ui";
import {
  artifactCategory,
  artifactDisplayName,
  artifactExtension,
  artifactIcon,
  formatBytes,
  isRootProjectFileCandidatePath,
  normalizeProjectFilePath,
} from "../utils/artifacts";
import { Icon, type IconName } from "./ArtifactIcons";
import { ArtifactPreview, artifactAiSelectionMessage, artifactFrameBackMessage, artifactHtmlEditMessage, isEditablePayload } from "./ArtifactPreview";
import { WorkflowPanel } from "./WorkflowPanel";

const artifactHistoryMarker = "myharnessArtifactPanel";
const artifactPanelMinWidth = 320;
const visibleChatMinWidth = 300;
const desktopSidebarWidth = 268;
const collapsedSidebarWidth = 16;
const projectFileCategories = [
  ["all", "전체"],
  ["web", "웹페이지"],
  ["markdown", "마크다운"],
  ["docs", "문서"],
  ["data", "데이터"],
  ["code", "코드"],
  ["other", "기타"],
];
const projectFileCategoryValues = new Set(projectFileCategories.map(([value]) => value));
const projectFilePinnedKeyPrefix = "myharness:projectFilePins";
type ArtifactPanelHistoryView = "list" | "detail" | "fullscreen";

function isArtifactHistoryState(value: unknown) {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>)[artifactHistoryMarker] === true);
}

function artifactHistoryState(view: ArtifactPanelHistoryView, artifact?: ArtifactSummary | null) {
  return {
    [artifactHistoryMarker]: true,
    view,
    path: artifact?.path || "",
    name: artifact?.name || "",
    kind: artifact?.kind || "",
    label: artifact?.label || "",
    size: artifact?.size,
  };
}

function sameArtifactHistoryState(nextState: Record<string, unknown>) {
  const current = history.state;
  return isArtifactHistoryState(current)
    && current.view === nextState.view
    && String(current.path || "") === String(nextState.path || "");
}

export function clampArtifactPanelWidth(value: number, options: { windowWidth: number; sidebarCollapsed: boolean }) {
  const sidebarWidth = options.sidebarCollapsed ? collapsedSidebarWidth : desktopSidebarWidth;
  const maxWidth = Math.max(artifactPanelMinWidth, options.windowWidth - sidebarWidth - visibleChatMinWidth);
  return Math.min(Math.max(value, artifactPanelMinWidth), maxWidth);
}

function artifactTypeBadge(artifact: ArtifactSummary) {
  const ext = artifactExtension(artifact.path || artifact.name || "");
  const category = artifactCategory(artifact);
  if (["html", "htm"].includes(ext)) return { label: "HTML", tone: "web" };
  if (["md", "markdown"].includes(ext)) return { label: "MD", tone: "markdown" };
  if (["txt", "log"].includes(ext)) return { label: "TXT", tone: "docs" };
  if (["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return { label: ext.toUpperCase(), tone: "docs" };
  if (["json", "csv", "xml", "yaml", "yml", "toml", "ini"].includes(ext)) return { label: ext.toUpperCase(), tone: "data" };
  if (["py", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css", "sql", "sh", "ps1", "bat", "cmd"].includes(ext)) return { label: ext.toUpperCase(), tone: "code" };
  if (["png", "gif", "jpg", "jpeg", "webp", "svg"].includes(ext)) return { label: ext.toUpperCase(), tone: "image" };
  if (ext === "zip") return { label: "ZIP", tone: "archive" };
  return { label: artifactIcon(artifact.kind), tone: category };
}

function truncateAiInstruction(value: string, maxLength = 8) {
  const text = String(value || "").trim();
  const chars = Array.from(text);
  return chars.length > maxLength ? `${chars.slice(0, maxLength).join("").trimEnd()}...` : text;
}

function formatAiEditElapsed(seconds: number) {
  if (seconds < 60) return `${seconds}초 경과`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return remainder ? `${minutes}분 ${remainder}초 경과` : `${minutes}분 경과`;
}

function meaningfulAiEditStatusText(value: string) {
  const text = String(value || "").trim();
  if (!text || text === "준비됨" || text === "연결 중") return "";
  return text;
}

function aiEditWaitingDetail(liveStatus: string, elapsedSeconds: number, targetPath: string) {
  if (liveStatus) return liveStatus;
  const targetName = targetPath ? artifactFileName(targetPath) : "";
  const targetPrefix = targetName
    ? `${targetName} 작업 요청은 전달됐습니다.`
    : "AI 편집 요청을 전달하고 있습니다.";
  if (elapsedSeconds >= 120) {
    return `${targetPrefix} ${formatAiEditElapsed(elapsedSeconds)}입니다. AI가 수정안을 작성 중이거나 이벤트 갱신이 지연되고 있어 계속 확인 중입니다.`;
  }
  if (elapsedSeconds >= 30) {
    return `${targetPrefix} ${formatAiEditElapsed(elapsedSeconds)}입니다. 첫 streaming 이벤트가 늦어지고 있어 계속 대기 중입니다.`;
  }
  if (elapsedSeconds >= 8) {
    return `${targetPrefix} 아직 첫 streaming 이벤트는 없고, AI가 수정 방향을 구성 중일 수 있습니다.`;
  }
  return `${targetPrefix} 첫 응답이나 도구 호출을 기다리고 있습니다.`;
}

function aiEditWaitingTitle(liveStatus: string, elapsedSeconds: number) {
  if (liveStatus) return "현재 상태";
  if (elapsedSeconds >= 120) return "AI 응답 대기 중";
  if (elapsedSeconds >= 30) return "streaming 이벤트 지연";
  return "첫 streaming 이벤트 대기";
}

function hasConcreteAiEditProgress(events: WorkflowEvent[]) {
  return events.some((event) => Boolean(event.toolName.trim()) || event.role === "final" || event.role === "activity");
}

function buildAiEditFallbackEvents({
  show,
  statusText,
  aiEditStatus,
  activePath,
  targetPath,
  commentCount,
  elapsedSeconds,
  liveProgressReceived,
}: {
  show: boolean;
  statusText: string;
  aiEditStatus: string;
  activePath: string;
  targetPath: string;
  commentCount: number;
  elapsedSeconds: number;
  liveProgressReceived: boolean;
}): WorkflowEvent[] {
  if (!show) return [];
  const sourceName = activePath ? artifactFileName(activePath) : "현재 문서";
  const targetName = targetPath ? artifactFileName(targetPath) : "새 버전";
  const liveStatus = meaningfulAiEditStatusText(statusText);
  const requestSent = Boolean(targetPath || !aiEditStatus.includes("전달 중"));
  const requestDetail = targetPath
    ? `${sourceName}에서 ${targetName}으로 수정 의견 ${commentCount}개를 반영합니다.`
    : `${sourceName}의 수정 의견 ${commentCount}개를 중앙 채팅으로 전달하고 있습니다.`;
  const waitingDetail = aiEditWaitingDetail(liveStatus, elapsedSeconds, targetPath);
  const events: WorkflowEvent[] = [
    {
      id: "artifact-ai-edit-request",
      toolName: "",
      title: "AI 편집 요청",
      detail: requestDetail,
      status: requestSent ? "done" : "running",
      level: "parent",
      role: "waiting",
    },
  ];
  if (requestSent && !liveProgressReceived) {
    events.push({
      id: "artifact-ai-edit-waiting",
      toolName: "",
      title: aiEditWaitingTitle(liveStatus, elapsedSeconds),
      detail: waitingDetail,
      status: "running",
      level: "parent",
      role: "waiting",
    });
  }
  return events;
}

function aiEditProgressSummary(events: WorkflowEvent[]) {
  const event = [...events].reverse().find((item) => item.status === "running") || events.at(-1);
  if (!event) return "";
  return [event.title, event.detail].filter(Boolean).join(" · ");
}

function projectFileDirectory(path: string) {
  const normalized = String(path || "").replace(/\\/g, "/");
  const index = normalized.lastIndexOf("/");
  return index > 0 ? normalized.slice(0, index) : "루트";
}

function groupedArtifacts(artifacts: ArtifactSummary[]) {
  const groups = new Map<string, ArtifactSummary[]>();
  for (const artifact of artifacts) {
    const directory = projectFileDirectory(artifact.path);
    groups.set(directory, [...(groups.get(directory) || []), artifact]);
  }
  return [...groups.entries()];
}

function projectFilePinnedStorageKey(workspacePath: string, workspaceName: string) {
  const workspaceId = normalizeProjectFilePath(workspacePath || workspaceName || "default");
  return `${projectFilePinnedKeyPrefix}:${encodeURIComponent(workspaceId)}`;
}

function readPinnedProjectFiles(storageKey: string) {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey) || "[]");
    if (!Array.isArray(parsed)) return new Set<string>();
    return new Set(parsed.map((value) => normalizeProjectFilePath(String(value))).filter(Boolean));
  } catch {
    return new Set<string>();
  }
}

function writePinnedProjectFiles(storageKey: string, paths: Set<string>) {
  try {
    localStorage.setItem(storageKey, JSON.stringify([...paths]));
  } catch {
    // Pinning is a local UI convenience; storage failures should not block file work.
  }
}

type ArtifactVersionInfo = {
  baseName: string;
  directory: string;
  ext: string;
  key: string;
  label: string;
  version: number;
};

function artifactVersionInfo(artifact: ArtifactSummary): ArtifactVersionInfo {
  const path = normalizeProjectFilePath(artifact.path || artifact.name || "");
  const slashIndex = path.lastIndexOf("/");
  const directory = slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  const fileName = slashIndex >= 0 ? path.slice(slashIndex + 1) : path;
  const ext = artifactExtension(fileName);
  const stem = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;
  const versionMatch = stem.match(/^(.*?)(?:[\s_]+(?:ver\.|v)(\d+))$/i);
  const version = versionMatch ? Number(versionMatch[2]) : 0;
  const baseName = (versionMatch ? versionMatch[1] : stem).trimEnd();
  return {
    baseName,
    directory,
    ext,
    key: `${directory}\u0000${baseName.toLowerCase()}\u0000${ext.toLowerCase()}`,
    label: version > 0 ? `v${version}` : "원본",
    version: Number.isFinite(version) ? version : 0,
  };
}

function artifactFileName(path: string) {
  const normalized = normalizeProjectFilePath(path);
  return normalized.split("/").filter(Boolean).pop() || normalized || "artifact";
}

function downloadUrl(artifact: ArtifactSummary, state: ReturnType<typeof useAppState>["state"]) {
  const query = new URLSearchParams({ clientId: state.clientId, path: artifact.path });
  if (state.sessionId) query.set("session", state.sessionId);
  const workspacePath = artifact.workspace?.path || state.workspacePath;
  const workspaceName = artifact.workspace?.name || state.workspaceName;
  if (workspacePath) query.set("workspacePath", workspacePath);
  if (workspaceName) query.set("workspaceName", workspaceName);
  return `/api/artifact/download?${query.toString()}`;
}

function ArtifactAction({
  label,
  icon,
  onClick,
  disabled,
  danger,
  active,
}: {
  label: string;
  icon: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  active?: boolean;
}) {
  return (
    <button
      className={`artifact-action${danger ? " danger" : ""}${active ? " active" : ""}`}
      type="button"
      aria-label={label}
      data-tooltip={label}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} />
    </button>
  );
}

function ArtifactDownloadAction({ artifact, url }: { artifact: ArtifactSummary; url: string }) {
  const displayName = artifactDisplayName(artifact);
  return (
    <a className="artifact-action" href={url} download={displayName} aria-label={`${displayName} 다운로드`} data-tooltip="다운로드">
      <Icon name="download" />
    </a>
  );
}

export function ArtifactPanel() {
  const { state, dispatch } = useAppState();
  const [loadingPath, setLoadingPath] = useState("");
  const [fileScope, setFileScope] = useState<"default" | "all">("default");
  const [fileFilter, setFileFilter] = useState(() => localStorage.getItem("myharness:projectFileFilter") || "all");
  const [fileSort, setFileSort] = useState(() => localStorage.getItem("myharness:projectFileSortMode") || "recent");
  const [fullscreen, setFullscreen] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [draftUserEdited, setDraftUserEdited] = useState(false);
  const [copyLabel, setCopyLabel] = useState("복사");
  const [sourceMode, setSourceMode] = useState(false);
  const [htmlEditMode, setHtmlEditMode] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [pendingDeletePath, setPendingDeletePath] = useState("");
  const [deletingPath, setDeletingPath] = useState("");
  const [organizeCandidates, setOrganizeCandidates] = useState<ArtifactSummary[] | null>(null);
  const [titleRenameEditing, setTitleRenameEditing] = useState(false);
  const [titleRenameValue, setTitleRenameValue] = useState("");
  const [titleRenameSaving, setTitleRenameSaving] = useState(false);
  const [aiEditComments, setAiEditComments] = useState<ArtifactAiEditComment[]>([]);
  const [pendingAiSelection, setPendingAiSelection] = useState<ArtifactAiEditSelection | null>(null);
  const [submittingAiEdit, setSubmittingAiEdit] = useState(false);
  const [aiEditStatus, setAiEditStatus] = useState("");
  const [aiEditTargetPath, setAiEditTargetPath] = useState("");
  const [aiEditProgressStartedAt, setAiEditProgressStartedAt] = useState<number | null>(null);
  const [aiEditProgressNow, setAiEditProgressNow] = useState(() => Date.now());
  const [aiEditOverlayCollapsed, setAiEditOverlayCollapsed] = useState(false);
  const [versionMenuOpen, setVersionMenuOpen] = useState(false);
  const skipNextHistoryPushRef = useRef(false);
  const titleRenameInputRef = useRef<HTMLInputElement | null>(null);
  const titleRenameCommittingRef = useRef(false);
  const versionMenuRef = useRef<HTMLDivElement | null>(null);
  const lastArtifactRefreshKeyRef = useRef(state.artifactRefreshKey);
  const openArtifactRequestRef = useRef(0);
  const projectFilePinnedStorage = useMemo(
    () => projectFilePinnedStorageKey(state.workspacePath, state.workspaceName),
    [state.workspaceName, state.workspacePath],
  );
  const [pinnedProjectFiles, setPinnedProjectFiles] = useState<Set<string>>(() => new Set());
  const visibleArtifacts = useMemo(() => sortedArtifacts(state.artifacts, fileFilter, fileSort), [fileFilter, fileSort, state.artifacts]);
  const activeVersionInfo = state.activeArtifact ? artifactVersionInfo(state.activeArtifact) : null;
  const activeVersionArtifacts = useMemo(() => {
    if (!state.activeArtifact || !activeVersionInfo) return [];
    const entries = new Map<string, { artifact: ArtifactSummary; info: ArtifactVersionInfo }>();
    for (const artifact of [...state.artifacts, state.activeArtifact]) {
      const info = artifactVersionInfo(artifact);
      if (info.key !== activeVersionInfo.key) continue;
      entries.set(normalizeProjectFilePath(artifact.path), { artifact, info });
    }
    return [...entries.values()].sort((left, right) => {
      return left.info.version - right.info.version
        || left.artifact.path.localeCompare(right.artifact.path, "ko");
    });
  }, [activeVersionInfo?.key, state.activeArtifact, state.artifacts]);
  const showVersionSwitcher = Boolean(state.activeArtifact && activeVersionArtifacts.length > 1);
  const showAiEditProgress = Boolean(aiEditStatus || submittingAiEdit || (state.busy && aiEditComments.length > 0));
  function requestHistoryBack() {
    if (!state.artifactPanelOpen || !isArtifactHistoryState(history.state)) {
      return false;
    }
    history.back();
    return true;
  }

  function closePanel() {
    if (state.activeArtifact) {
      openArtifactRequestRef.current += 1;
      skipNextHistoryPushRef.current = true;
      if (isArtifactHistoryState(history.state)) {
        history.replaceState(artifactHistoryState("list"), "", window.location.href);
      }
      setFullscreen(false);
      setLoadingPath("");
      dispatch({ type: "open_artifact_list" });
      return;
    }
    if (isArtifactHistoryState(history.state)) {
      history.replaceState(null, "", window.location.href);
    }
    dispatch({ type: "close_artifact" });
  }

  function returnToList() {
    if (requestHistoryBack()) {
      return;
    }
    openArtifactRequestRef.current += 1;
    setFullscreen(false);
    setLoadingPath("");
    dispatch({ type: "open_artifact_list" });
  }

  function toggleFullscreen() {
    if (fullscreen && isArtifactHistoryState(history.state) && history.state.view === "fullscreen") {
      requestHistoryBack();
      return;
    }
    setFullscreen((value) => !value);
  }

  useEffect(() => {
    if (aiEditTargetPath) {
      setVersionMenuOpen(false);
      return;
    }
    setHtmlEditMode(false);
    setSavingDraft(false);
    setTitleRenameEditing(false);
    setTitleRenameSaving(false);
    setTitleRenameValue("");
    setAiEditComments([]);
    setPendingAiSelection(null);
    setSubmittingAiEdit(false);
    setAiEditStatus("");
    setAiEditProgressStartedAt(null);
    setAiEditOverlayCollapsed(false);
    setVersionMenuOpen(false);
  }, [aiEditTargetPath, state.activeArtifact?.path]);

  useEffect(() => {
    setPinnedProjectFiles(readPinnedProjectFiles(projectFilePinnedStorage));
  }, [projectFilePinnedStorage]);

  useEffect(() => {
    if (!showAiEditProgress) {
      setAiEditProgressStartedAt(null);
      return undefined;
    }
    const startedAt = aiEditProgressStartedAt ?? Date.now();
    if (aiEditProgressStartedAt === null) {
      setAiEditProgressStartedAt(startedAt);
    }
    setAiEditProgressNow(Date.now());
    const timer = window.setInterval(() => setAiEditProgressNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [aiEditProgressStartedAt, showAiEditProgress]);

  useEffect(() => {
    if (!versionMenuOpen) return;
    function handlePointerDown(event: globalThis.PointerEvent) {
      const target = event.target instanceof Node ? event.target : null;
      if (target && versionMenuRef.current?.contains(target)) return;
      setVersionMenuOpen(false);
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setVersionMenuOpen(false);
    }
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [versionMenuOpen]);

  useEffect(() => {
    if (!titleRenameEditing) return;
    window.setTimeout(() => {
      titleRenameInputRef.current?.focus();
      titleRenameInputRef.current?.select();
    }, 0);
  }, [titleRenameEditing]);

  useEffect(() => {
    setDraftContent(String(state.activeArtifactPayload?.content ?? ""));
    setDraftPath(state.activeArtifact?.path || "");
    setDraftUserEdited(false);
    setCopyLabel("복사");
    setSourceMode(false);
  }, [state.activeArtifact?.path, state.activeArtifactPayload]);

  useEffect(() => {
    if (!state.artifactPanelOpen) {
      return;
    }
    const view: ArtifactPanelHistoryView = state.activeArtifact
      ? fullscreen ? "fullscreen" : "detail"
      : "list";
    const nextState = artifactHistoryState(view, state.activeArtifact);
    if (skipNextHistoryPushRef.current) {
      skipNextHistoryPushRef.current = false;
      return;
    }
    if (!sameArtifactHistoryState(nextState)) {
      history.pushState(nextState, "", window.location.href);
    }
  }, [fullscreen, state.activeArtifact, state.artifactPanelOpen]);

  useEffect(() => {
    function handlePopState(event: PopStateEvent) {
      if (isArtifactHistoryState(event.state)) {
        skipNextHistoryPushRef.current = true;
        if (event.state.view === "list") {
          openArtifactRequestRef.current += 1;
          setFullscreen(false);
          setLoadingPath("");
          dispatch({ type: "open_artifact_list" });
          return;
        }
        if ((event.state.view === "detail" || event.state.view === "fullscreen") && event.state.path) {
          const artifact = state.artifacts.find((item) => item.path === event.state.path) || {
            path: String(event.state.path),
            name: String(event.state.name || event.state.path),
            kind: String(event.state.kind || "file"),
            label: String(event.state.label || event.state.kind || "파일"),
            size: Number(event.state.size || 0),
          };
          setFullscreen(event.state.view === "fullscreen");
          void openArtifact(artifact);
          return;
        }
      }
      if (state.artifactPanelOpen) {
        setFullscreen(false);
        dispatch({ type: "close_artifact" });
      }
    }

    function handleFrameMessage(event: MessageEvent) {
      if (event.data?.type === artifactFrameBackMessage) {
        window.setTimeout(() => requestHistoryBack(), 180);
      }
      if (
        event.data?.type === artifactHtmlEditMessage
        && event.data.path === state.activeArtifact?.path
        && typeof event.data.html === "string"
      ) {
        setDraftContent(event.data.html);
        setDraftPath(event.data.path);
        setDraftUserEdited(true);
      }
      if (
        event.data?.type === artifactAiSelectionMessage
        && event.data.path === state.activeArtifact?.path
        && event.data.selection
      ) {
        const selection = event.data.selection as Partial<ArtifactAiEditSelection>;
        const instruction = typeof (selection as { instruction?: unknown }).instruction === "string"
          ? String((selection as { instruction?: string }).instruction)
          : "";
        if (
          typeof selection.text === "string"
          && typeof selection.start === "number"
          && typeof selection.end === "number"
          && selection.text.trim()
        ) {
          const normalizedSelection: ArtifactAiEditSelection = {
            text: selection.text,
            start: selection.start,
            end: selection.end,
            before: typeof selection.before === "string" ? selection.before : "",
            after: typeof selection.after === "string" ? selection.after : "",
            html: typeof selection.html === "string" ? selection.html : "",
            scope: selection.scope === "document" ? "document" : "selection",
          };
          const htmlSnapshot = typeof selection.htmlSnapshot === "string" ? selection.htmlSnapshot : "";
          if (htmlSnapshot) {
            setDraftContent(htmlSnapshot);
            setDraftPath(event.data.path);
            setDraftUserEdited(true);
          }
          setPendingAiSelection(normalizedSelection);
          if (instruction.trim()) {
            addAiEditComment(normalizedSelection, instruction);
          }
        }
      }
    }

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("message", handleFrameMessage);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("message", handleFrameMessage);
    };
  }, [dispatch, state.activeArtifact?.path, state.artifacts, state.artifactPanelOpen]);

  useEffect(() => {
    if (!state.artifactPanelOpen || state.activeArtifact) {
      return;
    }
    void refreshProjectFiles("default");
  }, [
    state.activeArtifact,
    state.artifactPanelOpen,
    state.clientId,
    state.sessionId,
    state.workspaceName,
    state.workspacePath,
  ]);

  useEffect(() => {
    if (lastArtifactRefreshKeyRef.current === state.artifactRefreshKey) {
      return;
    }
    lastArtifactRefreshKeyRef.current = state.artifactRefreshKey;
    if (!state.artifactPanelOpen || !state.activeArtifact || aiEditTargetPath) {
      return;
    }
    void openArtifact(state.activeArtifact);
  }, [
    aiEditTargetPath,
    state.activeArtifact?.path,
    state.artifactPanelOpen,
    state.artifactRefreshKey,
    state.clientId,
    state.sessionId,
    state.workspaceName,
    state.workspacePath,
  ]);

  async function openArtifact(artifact: ArtifactSummary) {
    const requestId = openArtifactRequestRef.current + 1;
    openArtifactRequestRef.current = requestId;
    const displayArtifact = { ...artifact, name: artifactDisplayName(artifact) };
    dispatch({ type: "open_artifact", artifact: displayArtifact });
    setLoadingPath(displayArtifact.path);
    try {
      const payload = await readArtifact({
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: displayArtifact.workspace?.path || state.workspacePath,
        workspaceName: displayArtifact.workspace?.name || state.workspaceName,
        path: displayArtifact.path,
      });
      if (requestId !== openArtifactRequestRef.current) {
        return;
      }
      dispatch({ type: "open_artifact", artifact: { ...displayArtifact, workspace: payload.workspace || displayArtifact.workspace }, payload });
    } catch (error) {
      if (requestId !== openArtifactRequestRef.current) {
        return;
      }
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      if (requestId === openArtifactRequestRef.current) {
        setLoadingPath("");
      }
    }
  }

  useEffect(() => {
    if (!aiEditTargetPath || state.busy) {
      return;
    }
    const fallbackArtifact = state.activeArtifact
      ? {
          ...state.activeArtifact,
          path: aiEditTargetPath,
          name: artifactFileName(aiEditTargetPath),
        }
      : null;
    const targetArtifact = state.artifacts.find((artifact) => artifact.path === aiEditTargetPath) || fallbackArtifact;
    if (!targetArtifact) {
      return;
    }
    const timer = window.setTimeout(() => {
      setAiEditTargetPath("");
      void openArtifact(targetArtifact);
    }, 120);
    return () => window.clearTimeout(timer);
  }, [aiEditTargetPath, state.activeArtifact, state.artifacts, state.busy]);

  if (!state.artifactPanelOpen) {
    return null;
  }

  const active = state.activeArtifact;
  const payload = state.activeArtifactPayload;
  const activePath = active?.path || "";
  const payloadHasContent = typeof payload?.content === "string";
  const canSave = Boolean(active && payload && isEditablePayload(active, payload));
  const canShowSource = Boolean(active && payloadHasContent);
  const activeExt = artifactExtension(active?.path || active?.name || "");
  const canEditHtmlPreview = Boolean(
    active
      && payloadHasContent
      && (String(payload.kind || active.kind || "").toLowerCase() === "html" || activeExt === "html" || activeExt === "htm"),
  );
  const originalContent = String(payload?.content ?? "");
  const draftContentForActive = draftUserEdited && draftPath === activePath ? draftContent : originalContent;
  const draftDirty = canSave && draftUserEdited && draftPath === activePath && draftContentForActive !== originalContent;
  const showHtmlDraftActions = htmlEditMode || draftDirty || savingDraft;
  const panelTitle = active ? `${artifactDisplayName(active)}${draftDirty ? " (편집됨)" : ""}` : "프로젝트 파일";
  const aiEditElapsedSeconds = aiEditProgressStartedAt === null
    ? 0
    : Math.max(0, Math.floor((aiEditProgressNow - aiEditProgressStartedAt) / 1000));
  const showAiEditFallbackProgress = showAiEditProgress && Boolean(aiEditStatus || submittingAiEdit || aiEditTargetPath);
  const aiEditLiveProgressEvents = showAiEditProgress && hasConcreteAiEditProgress(state.workflowEvents)
    ? state.workflowEvents
    : [];
  const aiEditFallbackEvents = buildAiEditFallbackEvents({
    show: showAiEditFallbackProgress,
    statusText: state.statusText,
    aiEditStatus,
    activePath,
    targetPath: aiEditTargetPath,
    commentCount: aiEditComments.length,
    elapsedSeconds: aiEditElapsedSeconds,
    liveProgressReceived: aiEditLiveProgressEvents.length > 0,
  });
  const aiEditProgressEvents = aiEditLiveProgressEvents.length
    ? [...aiEditFallbackEvents, ...aiEditLiveProgressEvents]
    : aiEditFallbackEvents;
  const aiEditProgressSummaryText = aiEditProgressSummary(aiEditProgressEvents);
  const aiEditWaitingText = aiEditProgressEvents.length
    ? ""
    : `AI 자동편집 요청 처리 중 · ${formatAiEditElapsed(aiEditElapsedSeconds)} · 응답 또는 도구 시작을 기다리고 있습니다.`;
  const aiEditCollapsedText = showAiEditProgress
    ? (aiEditProgressSummaryText || aiEditStatus || aiEditWaitingText || "AI 자동편집 진행 과정을 숨긴 상태입니다.")
    : `수정 의견 ${aiEditComments.length}개`;

  async function refreshProjectFiles(nextScope = fileScope) {
    try {
      const data = await listProjectFiles({
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        scope: nextScope,
      });
      setFileScope(data.scope === "all" ? "all" : "default");
      setPendingDeletePath("");
      dispatch({ type: "set_artifacts", artifacts: Array.isArray(data.files) ? data.files : [] });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  function changeFilter(value: string) {
    setFileFilter(value);
    setPendingDeletePath("");
    localStorage.setItem("myharness:projectFileFilter", value);
  }

  function changeSort(value: string) {
    const next = value === "path" ? "path" : "recent";
    setFileSort(next);
    setPendingDeletePath("");
    localStorage.setItem("myharness:projectFileSortMode", next);
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = state.artifactPanelWidth || Math.min(Math.max(window.innerWidth * 0.38, 360), 680);
    dispatch({ type: "set_artifact_resizing", value: true });
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Some test/browser paths do not support pointer capture for this event.
    }
    let finished = false;
    const finishResize = () => {
      if (finished) return;
      finished = true;
      dispatch({ type: "set_artifact_resizing", value: false });
      try {
        if (handle.hasPointerCapture(event.pointerId)) {
          handle.releasePointerCapture(event.pointerId);
        }
      } catch {
        // Pointer capture may already be gone if the browser canceled the pointer.
      }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
      window.removeEventListener("mouseup", finishResize);
      window.removeEventListener("blur", finishResize);
    };
    const onMove = (moveEvent: PointerEvent) => {
      if (moveEvent.buttons === 0) {
        finishResize();
        return;
      }
      const next = clampArtifactPanelWidth(startWidth + startX - moveEvent.clientX, {
        windowWidth: window.innerWidth,
        sidebarCollapsed: state.sidebarCollapsed,
      });
      dispatch({ type: "set_artifact_panel_width", value: Math.round(next) });
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    window.addEventListener("mouseup", finishResize);
    window.addEventListener("blur", finishResize);
  }

  async function copyActiveArtifact() {
    if (!active || !payload) return;
    const text = canSave ? draftContentForActive : String(payload.content ?? payload.dataUrl ?? "");
    if (!canSave && !text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopyLabel("복사됨");
      window.setTimeout(() => setCopyLabel("복사"), 1400);
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  async function saveHtmlDraft() {
    if (!active || !payload || !canEditHtmlPreview || !draftDirty) return;
    setSavingDraft(true);
    try {
      const saved = await overwriteArtifact({
        path: active.path,
        content: draftContentForActive,
        clientId: state.clientId,
        workspacePath: active.workspace?.path || payload.workspace?.path || state.workspacePath,
        workspaceName: active.workspace?.name || payload.workspace?.name || state.workspaceName,
      });
      const nextArtifact = { ...active, ...saved.artifact };
      dispatch({
        type: "set_artifacts",
        artifacts: state.artifacts.map((item) => item.path === active.path ? nextArtifact : item),
      });
      dispatch({ type: "open_artifact", artifact: nextArtifact, payload: saved.payload });
      setDraftContent(String(saved.payload.content ?? draftContentForActive));
      setDraftPath(nextArtifact.path);
      setDraftUserEdited(false);
    } catch (error) {
      setAiEditStatus("");
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setSavingDraft(false);
    }
  }

  function cancelHtmlDraft() {
    setDraftContent(originalContent);
    setDraftPath(active?.path || "");
    setDraftUserEdited(false);
    setHtmlEditMode(false);
  }

  function addAiEditComment(selection: ArtifactAiEditSelection, instruction: string) {
    const text = instruction.trim();
    if (!text) return;
    setAiEditComments((items) => [
      ...items,
      {
        ...selection,
        id: crypto.randomUUID?.() || `${Date.now()}-${items.length}`,
        instruction: text,
      },
    ]);
    setPendingAiSelection(null);
  }

  async function submitAiEdit() {
    if (!active || aiEditComments.length === 0 || submittingAiEdit) return;
    if (!state.sessionId) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: "AI 자동편집을 실행하려면 활성 세션이 필요합니다." },
      });
      return;
    }
    setSubmittingAiEdit(true);
    setAiEditOverlayCollapsed(false);
    setAiEditProgressStartedAt(Date.now());
    setAiEditProgressNow(Date.now());
    setAiEditStatus("AI 자동편집 요청을 중앙 채팅으로 전달 중입니다.");
    dispatch({ type: "clear_workflow" });
    try {
      const response = await aiEditArtifact({
        path: active.path,
        comments: aiEditComments,
        sessionId: state.sessionId,
        clientId: state.clientId,
        workspacePath: active.workspace?.path || payload?.workspace?.path || state.workspacePath,
        workspaceName: active.workspace?.name || payload?.workspace?.name || state.workspaceName,
      });
      const targetArtifact: ArtifactSummary = {
        ...active,
        path: response.targetPath,
        name: artifactFileName(response.targetPath),
        kind: active.kind || "html",
        workspace: active.workspace || payload?.workspace,
      };
      const nextArtifacts = [
        targetArtifact,
        ...state.artifacts.filter((artifact) => artifact.path !== response.targetPath),
      ];
      setAiEditTargetPath(response.targetPath);
      dispatch({ type: "set_artifacts", artifacts: nextArtifacts });
      setVersionMenuOpen(false);
      dispatch({ type: "set_busy", value: true });
      setAiEditStatus(`AI 자동편집 진행 중: ${response.targetPath}`);
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setSubmittingAiEdit(false);
    }
  }

  async function submitRenameArtifact(artifact: ArtifactSummary, name: string) {
    const saved = await renameArtifact({
      path: artifact.path,
      name,
      sessionId: state.sessionId || undefined,
      clientId: state.clientId,
      workspacePath: artifact.workspace?.path || state.workspacePath,
      workspaceName: artifact.workspace?.name || state.workspaceName,
    });
    const nextArtifact = { ...artifact, ...saved.artifact };
    const replaced = state.artifacts.some((item) => item.path === artifact.path);
    dispatch({
      type: "set_artifacts",
      artifacts: replaced
        ? state.artifacts.map((item) => item.path === artifact.path ? nextArtifact : item)
        : [nextArtifact, ...state.artifacts],
    });
    if (state.activeArtifact?.path === artifact.path) {
      dispatch({ type: "open_artifact", artifact: nextArtifact, payload: saved.payload });
      setDraftContent(String(saved.payload.content ?? ""));
      setDraftPath(nextArtifact.path);
      setDraftUserEdited(false);
    }
    const previousPath = normalizeProjectFilePath(artifact.path);
    const nextPath = normalizeProjectFilePath(saved.artifact.path);
    if (previousPath && nextPath && previousPath !== nextPath) {
      setPinnedProjectFiles((current) => {
        if (!current.has(previousPath)) return current;
        const next = new Set(current);
        next.delete(previousPath);
        next.add(nextPath);
        writePinnedProjectFiles(projectFilePinnedStorage, next);
        return next;
      });
    }
  }

  function toggleProjectFilePinned(artifact: ArtifactSummary) {
    const path = normalizeProjectFilePath(artifact.path);
    if (!path) return;
    setPinnedProjectFiles((current) => {
      const next = new Set(current);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      writePinnedProjectFiles(projectFilePinnedStorage, next);
      return next;
    });
  }

  function beginTitleRename() {
    if (!active || titleRenameSaving) return;
    setTitleRenameValue(artifactDisplayName(active));
    setTitleRenameEditing(true);
  }

  function cancelTitleRename() {
    setTitleRenameEditing(false);
    setTitleRenameValue("");
    titleRenameCommittingRef.current = false;
  }

  async function commitTitleRename() {
    if (!active || titleRenameCommittingRef.current) return;
    const nextName = titleRenameValue.trim();
    if (!nextName || nextName === artifactDisplayName(active)) {
      cancelTitleRename();
      return;
    }
    titleRenameCommittingRef.current = true;
    setTitleRenameSaving(true);
    try {
      await submitRenameArtifact(active, nextName);
      setTitleRenameEditing(false);
      setTitleRenameValue("");
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      titleRenameCommittingRef.current = false;
      setTitleRenameSaving(false);
    }
  }

  async function deleteProjectFile(artifact: ArtifactSummary) {
    if (pendingDeletePath !== artifact.path) {
      setPendingDeletePath(artifact.path);
      return;
    }
    setDeletingPath(artifact.path);
    try {
      await deleteArtifact({
        path: artifact.path,
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: artifact.workspace?.path || state.workspacePath,
        workspaceName: artifact.workspace?.name || state.workspaceName,
      });
      setPendingDeletePath("");
      setPinnedProjectFiles((current) => {
        const path = normalizeProjectFilePath(artifact.path);
        if (!current.has(path)) return current;
        const next = new Set(current);
        next.delete(path);
        writePinnedProjectFiles(projectFilePinnedStorage, next);
        return next;
      });
      dispatch({ type: "set_artifacts", artifacts: state.artifacts.filter((item) => item.path !== artifact.path) });
      if (state.activeArtifact?.path === artifact.path) {
        openArtifactRequestRef.current += 1;
        setLoadingPath("");
        dispatch({ type: "open_artifact_list" });
      }
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setDeletingPath("");
    }
  }

  async function organizeRootFiles(paths: string[]) {
    await organizeProjectFiles({
      paths,
      sessionId: state.sessionId || undefined,
      clientId: state.clientId,
      workspacePath: state.workspacePath,
      workspaceName: state.workspaceName,
    });
    setOrganizeCandidates(null);
    await refreshProjectFiles(fileScope);
  }

  return (
    <aside className={`artifact-panel${fullscreen ? " fullscreen" : ""}`} aria-label="산출물 미리보기">
      <button className="artifact-resize-handle" type="button" aria-label="패널 너비 조절" onPointerDown={beginResize} />
      <div className="artifact-panel-header">
        <div className="artifact-panel-title">
          <div className="artifact-title-row">
            {active && showVersionSwitcher ? (
              <div className="artifact-version-switcher" ref={versionMenuRef}>
                <button
                  className="artifact-version-trigger"
                  type="button"
                  aria-label="버전 선택"
                  aria-expanded={versionMenuOpen ? "true" : "false"}
                  data-tooltip="버전 선택"
                  onClick={() => setVersionMenuOpen((value) => !value)}
                >
                  {activeVersionInfo?.label || "v"}
                </button>
                {versionMenuOpen ? (
                  <div className="artifact-version-menu" role="menu" aria-label="산출물 버전">
                    {activeVersionArtifacts.map(({ artifact, info }) => {
                      const selected = artifact.path === active.path;
                      return (
                        <button
                          className={`artifact-version-option${selected ? " active" : ""}`}
                          type="button"
                          role="menuitem"
                          key={artifact.path}
                          disabled={selected}
                          onClick={() => {
                            setVersionMenuOpen(false);
                            void openArtifact(artifact);
                          }}
                        >
                          <span>{info.label}</span>
                          <small>{artifactDisplayName(artifact)}</small>
                        </button>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            ) : null}
            {active && titleRenameEditing ? (
              <input
                ref={titleRenameInputRef}
                className="artifact-title-rename-input"
                aria-label="파일명"
                value={titleRenameValue}
                disabled={titleRenameSaving}
                onChange={(event) => setTitleRenameValue(event.currentTarget.value)}
                onBlur={() => void commitTitleRename()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitTitleRename();
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    cancelTitleRename();
                  }
                }}
              />
            ) : active ? (
              <button
                className="artifact-title-rename-trigger"
                type="button"
                onDoubleClick={beginTitleRename}
                aria-label={`${artifactDisplayName(active)} 파일명 수정`}
                data-tooltip="더블클릭으로 파일명 수정"
              >
                <strong>{panelTitle}</strong>
              </button>
            ) : (
              <strong>{panelTitle}</strong>
            )}
          </div>
          {!active ? <small>{`${state.artifacts.length}개 파일`}</small> : null}
        </div>
        <div className="artifact-panel-actions">
          {active ? (
            <>
              {canEditHtmlPreview ? (
                <>
                  <ArtifactAction
                    label="본문 수정"
                    icon="edit"
                    onClick={() => {
                      setSourceMode(false);
                      setHtmlEditMode((value) => !value);
                    }}
                    active={htmlEditMode}
                  />
                  {showHtmlDraftActions ? (
                    <>
                      <ArtifactAction
                        label={savingDraft ? "반영 중" : "수정사항 반영"}
                        icon="save"
                        onClick={() => void saveHtmlDraft()}
                        disabled={!draftDirty || savingDraft}
                      />
                      <ArtifactAction
                        label="편집 취소"
                        icon="undo"
                        onClick={cancelHtmlDraft}
                        disabled={!draftDirty || savingDraft}
                        danger={draftDirty}
                      />
                    </>
                  ) : null}
                </>
              ) : null}
              <ArtifactAction
                label={sourceMode ? "미리보기" : "소스코드 확인"}
                icon={sourceMode ? "preview" : "source"}
                onClick={() => setSourceMode((value) => !value)}
                disabled={!canShowSource}
                active={sourceMode}
              />
              <ArtifactAction label={copyLabel === "복사됨" ? "복사됨" : "소스코드 복사"} icon="copy" onClick={() => void copyActiveArtifact()} disabled={!payload || (!canSave && !payload.content && !payload.dataUrl)} active={copyLabel === "복사됨"} />
            </>
          ) : null}
          <ArtifactAction label={fullscreen ? "미리보기 축소" : "미리보기 확대"} icon={fullscreen ? "restore" : "fullscreen"} onClick={toggleFullscreen} />
          {active ? <ArtifactDownloadAction artifact={active} url={downloadUrl(active, state)} /> : null}
          <ArtifactAction label="닫기" icon="close" onClick={closePanel} />
        </div>
      </div>
      {active && canEditHtmlPreview && (aiEditComments.length > 0 || aiEditStatus) ? (
        <div className={`artifact-ai-comments${showAiEditProgress ? " with-progress" : ""}${aiEditOverlayCollapsed ? " collapsed" : ""}`} aria-label="AI 수정 의견">
          {aiEditOverlayCollapsed ? (
            <>
              <span className="artifact-ai-comment-index">{aiEditComments.length || 1}</span>
              <button
                className="artifact-ai-collapsed-summary"
                type="button"
                aria-label={`AI 수정 패널 요약: ${aiEditCollapsedText}`}
                data-tooltip="다시 펼치기"
                onClick={() => {
                  setAiEditProgressNow(Date.now());
                  setAiEditOverlayCollapsed(false);
                }}
              >
                {aiEditCollapsedText}
              </button>
              <button
                className="artifact-ai-toggle"
                type="button"
                aria-label="AI 수정 패널 다시 펼치기"
                aria-expanded="false"
                data-tooltip="다시 펼치기"
                onClick={() => {
                  setAiEditProgressNow(Date.now());
                  setAiEditOverlayCollapsed(false);
                }}
              >
                <Icon name="chevron-down" />
              </button>
            </>
          ) : (
            <>
              <div className="artifact-ai-comments-header">
                {aiEditStatus ? <p className="artifact-ai-status">{aiEditStatus}</p> : <p className="artifact-ai-status">{`수정 의견 ${aiEditComments.length}개`}</p>}
                <button
                  className="artifact-ai-toggle"
                  type="button"
                  aria-label="AI 수정 패널 접기"
                  aria-expanded="true"
                  data-tooltip="접기"
                  onClick={() => {
                    setAiEditProgressNow(Date.now());
                    setAiEditOverlayCollapsed(true);
                  }}
                >
                  <Icon name="chevron-up" />
                </button>
              </div>
              {aiEditComments.map((comment, index) => (
                <div
                  className="artifact-ai-comment"
                  key={comment.id}
                  aria-label={`AI 수정 의견 ${index + 1}: ${comment.instruction}`}
                  data-tooltip={`${index + 1}. ${comment.instruction}`}
                >
                  <span className="artifact-ai-comment-index">{index + 1}</span>
                  <span className="artifact-ai-comment-instruction">{truncateAiInstruction(comment.instruction)}</span>
                  <button
                    type="button"
                    aria-label={`AI 수정 의견 ${index + 1} 삭제`}
                    data-tooltip="삭제"
                    onClick={() => {
                      setAiEditComments((items) => items.filter((item) => item.id !== comment.id));
                      setAiEditStatus("");
                    }}
                  >
                    <Icon name="close" />
                  </button>
                </div>
              ))}
              <button
                className="artifact-ai-submit"
                type="button"
                onClick={() => void submitAiEdit()}
                disabled={aiEditComments.length === 0 || submittingAiEdit || state.busy}
                aria-label={submittingAiEdit ? "AI 자동편집 요청 중" : "AI 자동편집"}
              >
                <Icon name="ai" />
                <span>{submittingAiEdit ? "요청 중" : "AI 자동편집"}</span>
              </button>
              {showAiEditProgress ? (
                <div className="artifact-ai-progress" aria-label="AI 자동편집 진행 과정" role="status" aria-live="polite">
                  <WorkflowPanel
                    events={aiEditProgressEvents}
                    durationSeconds={aiEditLiveProgressEvents.length ? state.workflowDurationSeconds : aiEditElapsedSeconds}
                  />
                  {!aiEditProgressEvents.length ? (
                    <p className="artifact-ai-progress-empty" role="status" aria-live="polite">
                      <span className="artifact-ai-progress-pulse" aria-hidden="true" />
                      <span>{aiEditWaitingText}</span>
                    </p>
                  ) : null}
                </div>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      <div className="artifact-viewer" key={active ? "detail" : "list"}>
        {!active ? (
          <ArtifactList
            artifacts={visibleArtifacts}
            totalCount={state.artifacts.length}
            loadingPath={loadingPath}
            filter={fileFilter}
            sort={fileSort}
            scope={fileScope}
            onFilterChange={changeFilter}
            onSortChange={changeSort}
            onToggleScope={() => void refreshProjectFiles(fileScope === "all" ? "default" : "all")}
            onRefresh={() => void refreshProjectFiles(fileScope)}
            onOpen={openArtifact}
            onDelete={deleteProjectFile}
            onTogglePinned={toggleProjectFilePinned}
            onRename={submitRenameArtifact}
            onOrganize={setOrganizeCandidates}
            allArtifacts={state.artifacts}
            getDownloadUrl={(artifact) => downloadUrl(artifact, state)}
            collapsedDirs={collapsedDirs}
            pinnedPaths={pinnedProjectFiles}
            pendingDeletePath={pendingDeletePath}
            deletingPath={deletingPath}
            onToggleDirectory={(directory) => setCollapsedDirs((current) => {
              const next = new Set(current);
              if (next.has(directory)) next.delete(directory);
              else next.add(directory);
              return next;
            })}
          />
        ) : payload ? (
          <ArtifactPreview
            artifact={active}
            payload={payload}
            draftContent={draftContentForActive}
            draftDirty={draftDirty}
            sourceMode={sourceMode}
            downloadUrl={downloadUrl(active, state)}
            htmlEditMode={htmlEditMode}
            aiSelectionEnabled={canEditHtmlPreview && htmlEditMode}
            aiEditComments={aiEditComments}
            onDraftContentChange={(value) => {
              setDraftContent(value);
              setDraftPath(active.path);
              setDraftUserEdited(true);
            }}
          />
        ) : (
          <p className="artifact-empty">산출물을 불러오는 중...</p>
        )}
      </div>
      {organizeCandidates ? (
        <OrganizeProjectFilesModal
          candidates={organizeCandidates}
          onClose={() => setOrganizeCandidates(null)}
          onSubmit={organizeRootFiles}
        />
      ) : null}
      {pendingAiSelection ? (
        <AiEditCommentModal
          selection={pendingAiSelection}
          onClose={() => setPendingAiSelection(null)}
          onSubmit={(instruction) => addAiEditComment(pendingAiSelection, instruction)}
        />
      ) : null}
    </aside>
  );
}

function isRootOrganizeCandidate(artifact: ArtifactSummary) {
  return isRootProjectFileCandidatePath(artifact.path || artifact.name || "");
}

function sortedArtifacts(artifacts: ArtifactSummary[], filter: string, sort: string) {
  const normalizedFilter = projectFileCategoryValues.has(filter) ? filter : "all";
  return artifacts
    .filter((artifact) => normalizedFilter === "all" || artifactCategory(artifact) === normalizedFilter)
    .slice()
    .sort((left, right) => {
      if (sort === "path") {
        return left.path.localeCompare(right.path, "ko");
      }
      return Number(right.mtimeMs || right.birthtimeMs || 0) - Number(left.mtimeMs || left.birthtimeMs || 0)
        || left.path.localeCompare(right.path, "ko");
    });
}

function ArtifactList({
  artifacts,
  allArtifacts,
  totalCount,
  loadingPath,
  filter,
  sort,
  scope,
  onFilterChange,
  onSortChange,
  onToggleScope,
  onRefresh,
  onOpen,
  onDelete,
  onTogglePinned,
  onRename,
  onOrganize,
  getDownloadUrl,
  collapsedDirs,
  pinnedPaths,
  pendingDeletePath,
  deletingPath,
  onToggleDirectory,
}: {
  artifacts: ArtifactSummary[];
  allArtifacts: ArtifactSummary[];
  totalCount: number;
  loadingPath: string;
  filter: string;
  sort: string;
  scope: "default" | "all";
  onFilterChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onToggleScope: () => void;
  onRefresh: () => void;
  onOpen: (artifact: ArtifactSummary) => void;
  onDelete: (artifact: ArtifactSummary) => void;
  onTogglePinned: (artifact: ArtifactSummary) => void;
  onRename: (artifact: ArtifactSummary, name: string) => Promise<void>;
  onOrganize: (artifacts: ArtifactSummary[]) => void;
  getDownloadUrl: (artifact: ArtifactSummary) => string;
  collapsedDirs: Set<string>;
  pinnedPaths: Set<string>;
  pendingDeletePath: string;
  deletingPath: string;
  onToggleDirectory: (directory: string) => void;
}) {
  const categories = projectFileCategories;
  const organizeCandidates = allArtifacts.filter(isRootOrganizeCandidate);
  const pinnedArtifacts = artifacts.filter((artifact) => pinnedPaths.has(normalizeProjectFilePath(artifact.path)));

  if (!artifacts.length) {
    return (
      <>
        <ProjectFileToolbar
          totalCount={totalCount}
          filter={filter}
          sort={sort}
          scope={scope}
          categories={categories}
          organizeCandidates={organizeCandidates}
          onFilterChange={onFilterChange}
          onSortChange={onSortChange}
          onOrganize={onOrganize}
          onToggleScope={onToggleScope}
          onRefresh={onRefresh}
        />
        <p className="artifact-empty">표시할 프로젝트 파일이 아직 없습니다.</p>
      </>
    );
  }
  const groups = groupedArtifacts(artifacts);
  return (
    <>
      <ProjectFileToolbar
        totalCount={totalCount}
        filter={filter}
        sort={sort}
        scope={scope}
        categories={categories}
        organizeCandidates={organizeCandidates}
        onFilterChange={onFilterChange}
        onSortChange={onSortChange}
        onOrganize={onOrganize}
        onToggleScope={onToggleScope}
        onRefresh={onRefresh}
      />
      <div className="project-file-list">
        {pinnedArtifacts.length ? (
          <section className="project-file-section project-file-section-pinned">
            <div className="project-file-section-header project-file-section-header-static">
              <span className="project-file-section-caret" aria-hidden="true">★</span>
              <span className="project-file-section-title">즐겨찾기</span>
              <small>{pinnedArtifacts.length}개</small>
            </div>
            <div className="project-file-section-body">
              {pinnedArtifacts.map((artifact) => (
                <ProjectFileItem
                  artifact={artifact}
                  deleting={deletingPath === artifact.path}
                  deleteReady={pendingDeletePath === artifact.path}
                  downloadUrl={getDownloadUrl(artifact)}
                  key={`pinned-${artifact.path}`}
                  loading={loadingPath === artifact.path}
                  pinned={pinnedPaths.has(normalizeProjectFilePath(artifact.path))}
                  onDelete={onDelete}
                  onOpen={onOpen}
                  onRename={onRename}
                  onTogglePinned={onTogglePinned}
                />
              ))}
            </div>
          </section>
        ) : null}
        {groups.map(([directory, groupArtifacts]) => (
          <section className={`project-file-section${collapsedDirs.has(directory) ? " collapsed" : ""}`} key={directory}>
            <button className="project-file-section-header" type="button" aria-expanded={collapsedDirs.has(directory) ? "false" : "true"} onClick={() => onToggleDirectory(directory)}>
              <span className="project-file-section-caret" aria-hidden="true">›</span>
              <span className="project-file-section-title">{directory}</span>
              <small>{groupArtifacts.length}개</small>
            </button>
            {collapsedDirs.has(directory) ? null : (
              <div className="project-file-section-body">
                {groupArtifacts.map((artifact) => (
                  <ProjectFileItem
                    artifact={artifact}
                    deleting={deletingPath === artifact.path}
                    deleteReady={pendingDeletePath === artifact.path}
                    downloadUrl={getDownloadUrl(artifact)}
                    key={artifact.path}
                    loading={loadingPath === artifact.path}
                    pinned={pinnedPaths.has(normalizeProjectFilePath(artifact.path))}
                    onDelete={onDelete}
                    onOpen={onOpen}
                    onRename={onRename}
                    onTogglePinned={onTogglePinned}
                  />
                ))}
              </div>
            )}
          </section>
        ))}
      </div>
    </>
  );
}

function ProjectFileItem({
  artifact,
  deleteReady,
  deleting,
  downloadUrl,
  loading,
  pinned,
  onDelete,
  onOpen,
  onRename,
  onTogglePinned,
}: {
  artifact: ArtifactSummary;
  deleteReady: boolean;
  deleting: boolean;
  downloadUrl: string;
  loading: boolean;
  pinned: boolean;
  onDelete: (artifact: ArtifactSummary) => void;
  onOpen: (artifact: ArtifactSummary) => void;
  onRename: (artifact: ArtifactSummary, name: string) => Promise<void>;
  onTogglePinned: (artifact: ArtifactSummary) => void;
}) {
  const badge = artifactTypeBadge(artifact);
  const displayName = artifactDisplayName(artifact);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState(displayName);
  const [renameSaving, setRenameSaving] = useState(false);
  const [renameError, setRenameError] = useState("");
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editingName) {
      setNameValue(displayName);
      setRenameError("");
      return;
    }
    window.setTimeout(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    }, 0);
  }, [displayName, editingName]);

  function beginRename() {
    setNameValue(displayName);
    setRenameError("");
    setEditingName(true);
  }

  function cancelRename() {
    setEditingName(false);
    setNameValue(displayName);
    setRenameError("");
  }

  async function commitRename() {
    if (renameSaving) return;
    const nextName = nameValue.trim();
    const currentName = displayName;
    if (!nextName) {
      setRenameError("파일명을 입력하세요.");
      return;
    }
    if (nextName === currentName) {
      cancelRename();
      return;
    }
    setRenameSaving(true);
    setRenameError("");
    try {
      await onRename(artifact, nextName);
      setEditingName(false);
    } catch (error) {
      setRenameError(`파일명 수정 실패: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setRenameSaving(false);
    }
  }

  const pinButton = (
    <button
      className={`project-file-pin${pinned ? " active" : ""}`}
      type="button"
      aria-label={`${displayName} ${pinned ? "즐겨찾기 해제" : "즐겨찾기 추가"}`}
      aria-pressed={pinned ? "true" : "false"}
      data-tooltip={pinned ? "즐겨찾기 해제" : "즐겨찾기 추가"}
      onClick={(event) => {
        event.stopPropagation();
        onTogglePinned(artifact);
      }}
    >
      <Icon name="star" />
    </button>
  );

  return (
    <div className={`project-file-item${deleteReady ? " delete-ready" : ""}${deleting ? " deleting" : ""}`}>
      <div className={`project-file-main${pinned ? " project-file-main-pinned" : ""}${editingName ? " project-file-main-editing" : ""}`}>
        <span className={`artifact-card-icon artifact-card-icon-${badge.tone}`} aria-hidden="true">{badge.label}</span>
        {pinned ? pinButton : null}
        {editingName ? (
          <span className="artifact-card-copy project-file-inline-rename">
            <input
              ref={nameInputRef}
              aria-label={`${displayName} 새 파일명`}
              value={nameValue}
              disabled={renameSaving}
              onBlur={() => void commitRename()}
              onChange={(event) => setNameValue(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void commitRename();
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  cancelRename();
                }
              }}
            />
            {renameError ? <small>{renameError}</small> : null}
          </span>
        ) : (
          <button className="project-file-open" type="button" aria-label={`${displayName} 열기`} data-tooltip={displayName} onClick={() => void onOpen(artifact)}>
            <span className="artifact-card-copy">
              <strong>{displayName}</strong>
            </span>
          </button>
        )}
      </div>
      <span className={`project-file-actions${pinned ? "" : " project-file-actions-with-pin"}`}>
        {pinned ? null : pinButton}
        <button
          className="project-file-rename"
          type="button"
          aria-label={`${displayName} 파일명 수정`}
          data-tooltip="파일명 수정"
          disabled={renameSaving}
          onClick={(event) => {
            event.stopPropagation();
            beginRename();
          }}
        >
          <Icon name="rename" />
        </button>
        <button
          className="project-file-delete"
          type="button"
          aria-label={deleteReady ? `${displayName} 삭제 확인` : `${displayName} 삭제`}
          data-tooltip={deleteReady ? "한 번 더 누르면 삭제됩니다" : "파일 삭제"}
          disabled={deleting}
          onClick={(event) => {
            event.stopPropagation();
            void onDelete(artifact);
          }}
        >
          <Icon name={deleteReady ? "warning" : "trash"} />
        </button>
        <span className="project-file-size artifact-card-size">{loading ? "불러오는 중" : formatBytes(artifact.size)}</span>
        <a className="project-file-download" href={downloadUrl} download={displayName} aria-label={`${displayName} 다운로드`} data-tooltip="다운로드" onClick={(event) => event.stopPropagation()}>
          <Icon name="download" />
        </a>
      </span>
    </div>
  );
}

function ProjectFileToolbar({
  totalCount,
  filter,
  sort,
  scope,
  categories,
  organizeCandidates,
  onFilterChange,
  onSortChange,
  onOrganize,
  onToggleScope,
  onRefresh,
}: {
  totalCount: number;
  filter: string;
  sort: string;
  scope: "default" | "all";
  categories: string[][];
  organizeCandidates: ArtifactSummary[];
  onFilterChange: (value: string) => void;
  onSortChange: (value: string) => void;
  onOrganize: (artifacts: ArtifactSummary[]) => void;
  onToggleScope: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="project-file-toolbar">
      <span className="project-file-sort-summary">{scope === "all" ? "전체" : "outputs"} · {totalCount}개</span>
      <div className="project-file-controls">
        <label className="project-file-sort">
          <span>유형</span>
          <select aria-label="프로젝트 파일 유형 필터" value={projectFileCategoryValues.has(filter) ? filter : "all"} onChange={(event) => onFilterChange(event.currentTarget.value)}>
            {categories.map(([value, label]) => <option value={value} key={value}>{label}</option>)}
          </select>
        </label>
        <label className="project-file-sort">
          <span>정렬</span>
          <select aria-label="프로젝트 파일 정렬" value={sort} onChange={(event) => onSortChange(event.currentTarget.value)}>
            <option value="recent">최근순</option>
            <option value="path">경로순</option>
          </select>
        </label>
        <button className="project-file-toolbar-button" type="button" disabled={!organizeCandidates.length} onClick={() => onOrganize(organizeCandidates)}>정리</button>
        <button className="project-file-toolbar-button" type="button" onClick={onToggleScope}>{scope === "all" ? "outputs만" : "전체 보기"}</button>
        <button className="project-file-toolbar-button" type="button" onClick={onRefresh}>새로고침</button>
      </div>
    </div>
  );
}

function AiEditCommentModal({
  selection,
  onClose,
  onSubmit,
}: {
  selection: ArtifactAiEditSelection;
  onClose: () => void;
  onSubmit: (instruction: string) => void;
}) {
  const [instruction, setInstruction] = useState("");
  const canSubmit = instruction.trim().length > 0;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card artifact-ai-comment-card" role="dialog" aria-modal="true" aria-label="AI 수정 의견 작성" onClick={(event) => event.stopPropagation()}>
        <div className="modal-header">
          <h2>AI 수정 의견</h2>
          <button className="modal-close" type="button" onClick={onClose} aria-label="닫기">×</button>
        </div>
        <blockquote className="artifact-ai-selection-preview">{selection.text}</blockquote>
        <label className="artifact-ai-comment-field">
          <span>수정 의견</span>
          <textarea
            autoFocus
            value={instruction}
            onChange={(event) => setInstruction(event.currentTarget.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && canSubmit) {
                event.preventDefault();
                onSubmit(instruction);
              }
            }}
            placeholder="이 영역을 어떻게 바꿀지 입력하세요."
          />
        </label>
        <div className="modal-actions">
          <button type="button" onClick={onClose}>취소</button>
          <button type="button" onClick={() => onSubmit(instruction)} disabled={!canSubmit}>추가</button>
        </div>
      </div>
    </div>
  );
}

function OrganizeProjectFilesModal({
  candidates,
  onClose,
  onSubmit,
}: {
  candidates: ArtifactSummary[];
  onClose: () => void;
  onSubmit: (paths: string[]) => Promise<void>;
}) {
  const [selectedPaths, setSelectedPaths] = useState(() => new Set(candidates.map((artifact) => normalizeProjectFilePath(artifact.path))));
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    const paths = candidates
      .map((artifact) => normalizeProjectFilePath(artifact.path))
      .filter((path) => selectedPaths.has(path));
    if (!paths.length) {
      setError("이동할 파일을 선택하세요.");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      await onSubmit(paths);
    } catch (submitError) {
      setError(`정리 실패: ${submitError instanceof Error ? submitError.message : String(submitError)}`);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className="modal-card project-file-organize-card" role="dialog" aria-modal="true" aria-label="루트 산출물 정리">
        <button className="modal-close" type="button" aria-label="닫기" onClick={onClose}>
          <Icon name="close" />
        </button>
        <h2>루트 산출물 정리</h2>
        <p>선택한 루트 파일을 outputs 폴더로 이동합니다. 같은 이름은 자동으로 번호를 붙입니다.</p>
        <div className="project-file-organize-list">
          {candidates.map((artifact) => {
            const path = normalizeProjectFilePath(artifact.path);
            return (
              <label className="project-file-organize-row" key={path}>
                <input
                  type="checkbox"
                  value={path}
                  checked={selectedPaths.has(path)}
                  onChange={(event) => setSelectedPaths((current) => {
                    const next = new Set(current);
                    if (event.currentTarget.checked) next.add(path);
                    else next.delete(path);
                    return next;
                  })}
                />
                <span>
                  <strong>{path}</strong>
                  <small>{`outputs/${artifactDisplayName(artifact)}`}</small>
                </span>
              </label>
            );
          })}
        </div>
        <p className="settings-helper workspace-error">{error}</p>
        <div className="modal-actions">
          <button type="button" className="modal-button" onClick={onClose} disabled={submitting}>취소</button>
          <button type="button" className="modal-button primary" onClick={() => void submit()} disabled={submitting}>선택 파일 이동</button>
        </div>
      </div>
    </div>
  );
}
