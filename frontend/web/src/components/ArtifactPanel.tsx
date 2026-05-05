import { useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { deleteArtifact, listProjectFiles, organizeProjectFiles, readArtifact } from "../api/artifacts";
import { useAppState } from "../state/app-state";
import type { ArtifactSummary } from "../types/backend";
import {
  artifactCategory,
  artifactExtension,
  artifactIcon,
  artifactKindLabel,
  formatBytes,
  isRootProjectFileCandidatePath,
  normalizeProjectFilePath,
} from "../utils/artifacts";
import { Icon, type IconName } from "./ArtifactIcons";
import { ArtifactPreview, artifactFrameBackMessage, isEditablePayload } from "./ArtifactPreview";

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

function artifactLabel(artifact: ArtifactSummary) {
  if (["html", "image", "pdf", "text"].includes(artifact.kind)) return artifactKindLabel(artifact.kind);
  return artifact.label || artifact.kind || "파일";
}

function artifactTypeBadge(artifact: ArtifactSummary) {
  const ext = artifactExtension(artifact.path || artifact.name);
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

function downloadUrl(artifact: ArtifactSummary, state: ReturnType<typeof useAppState>["state"]) {
  const query = new URLSearchParams({ clientId: state.clientId, path: artifact.path });
  if (state.sessionId) query.set("session", state.sessionId);
  if (state.workspacePath) query.set("workspacePath", state.workspacePath);
  if (state.workspaceName) query.set("workspaceName", state.workspaceName);
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
export function ArtifactPanel() {
  const { state, dispatch } = useAppState();
  const [loadingPath, setLoadingPath] = useState("");
  const [fileScope, setFileScope] = useState<"default" | "all">("default");
  const [fileFilter, setFileFilter] = useState(() => localStorage.getItem("myharness:projectFileFilter") || "all");
  const [fileSort, setFileSort] = useState(() => localStorage.getItem("myharness:projectFileSortMode") || "recent");
  const [fullscreen, setFullscreen] = useState(false);
  const [draftContent, setDraftContent] = useState("");
  const [copyLabel, setCopyLabel] = useState("복사");
  const [sourceMode, setSourceMode] = useState(false);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(() => new Set());
  const [pendingDeletePath, setPendingDeletePath] = useState("");
  const [deletingPath, setDeletingPath] = useState("");
  const [organizeCandidates, setOrganizeCandidates] = useState<ArtifactSummary[] | null>(null);
  const skipNextHistoryPushRef = useRef(false);
  const visibleArtifacts = useMemo(() => sortedArtifacts(state.artifacts, fileFilter, fileSort), [fileFilter, fileSort, state.artifacts]);

  function requestHistoryBack() {
    if (!state.artifactPanelOpen || !isArtifactHistoryState(history.state)) {
      return false;
    }
    history.back();
    return true;
  }

  function closePanel() {
    if (state.activeArtifact) {
      skipNextHistoryPushRef.current = true;
      if (isArtifactHistoryState(history.state)) {
        history.replaceState(artifactHistoryState("list"), "", window.location.href);
      }
      setFullscreen(false);
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
    setFullscreen(false);
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
    setDraftContent(String(state.activeArtifactPayload?.content || ""));
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
          setFullscreen(false);
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

    function handleFrameBackMessage(event: MessageEvent) {
      if (event.data?.type === artifactFrameBackMessage) {
        window.setTimeout(() => requestHistoryBack(), 180);
      }
    }

    window.addEventListener("popstate", handlePopState);
    window.addEventListener("message", handleFrameBackMessage);
    return () => {
      window.removeEventListener("popstate", handlePopState);
      window.removeEventListener("message", handleFrameBackMessage);
    };
  }, [dispatch, state.artifacts, state.artifactPanelOpen]);

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

  async function openArtifact(artifact: ArtifactSummary) {
    dispatch({ type: "open_artifact", artifact });
    setLoadingPath(artifact.path);
    try {
      const payload = await readArtifact({
        sessionId: state.sessionId || undefined,
        clientId: state.clientId,
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
        path: artifact.path,
      });
      dispatch({ type: "set_artifact_payload", payload });
    } catch (error) {
      dispatch({
        type: "open_modal",
        modal: { kind: "error", message: error instanceof Error ? error.message : String(error) },
      });
    } finally {
      setLoadingPath("");
    }
  }

  if (!state.artifactPanelOpen) {
    return null;
  }

  const active = state.activeArtifact;
  const payload = state.activeArtifactPayload;
  const canSave = Boolean(active && payload && isEditablePayload(active, payload));
  const canShowSource = Boolean(active && payload?.content);

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
    const text = canSave ? draftContent : String(payload.content || payload.dataUrl || "");
    if (!text) return;
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
        workspacePath: state.workspacePath,
        workspaceName: state.workspaceName,
      });
      setPendingDeletePath("");
      dispatch({ type: "set_artifacts", artifacts: state.artifacts.filter((item) => item.path !== artifact.path) });
      if (state.activeArtifact?.path === artifact.path) {
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
          <strong>{active?.name || "프로젝트 파일"}</strong>
          <small>{active ? `${artifactLabel(active)} · ${active.path}` : `${state.artifacts.length}개 파일`}</small>
        </div>
        <div className="artifact-panel-actions">
          {active ? (
            <>
              <ArtifactAction
                label={sourceMode ? "미리보기" : "원문보기"}
                icon={sourceMode ? "preview" : "source"}
                onClick={() => setSourceMode((value) => !value)}
                disabled={!canShowSource}
                active={sourceMode}
              />
              <ArtifactAction label={copyLabel === "복사됨" ? "복사됨" : "원문 복사"} icon="copy" onClick={() => void copyActiveArtifact()} disabled={!payload || (!canSave && !payload.content && !payload.dataUrl)} active={copyLabel === "복사됨"} />
            </>
          ) : null}
          <ArtifactAction label={fullscreen ? "미리보기 축소" : "미리보기 확대"} icon={fullscreen ? "restore" : "fullscreen"} onClick={toggleFullscreen} />
          <ArtifactAction label="닫기" icon="close" onClick={closePanel} />
        </div>
      </div>
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
            onOrganize={setOrganizeCandidates}
            allArtifacts={state.artifacts}
            getDownloadUrl={(artifact) => downloadUrl(artifact, state)}
            collapsedDirs={collapsedDirs}
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
            draftContent={draftContent}
            sourceMode={sourceMode}
            downloadUrl={downloadUrl(active, state)}
            onDraftContentChange={setDraftContent}
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
  onOrganize,
  getDownloadUrl,
  collapsedDirs,
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
  onOrganize: (artifacts: ArtifactSummary[]) => void;
  getDownloadUrl: (artifact: ArtifactSummary) => string;
  collapsedDirs: Set<string>;
  pendingDeletePath: string;
  deletingPath: string;
  onToggleDirectory: (directory: string) => void;
}) {
  const categories = projectFileCategories;
  const organizeCandidates = allArtifacts.filter(isRootOrganizeCandidate);

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
                    onDelete={onDelete}
                    onOpen={onOpen}
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
  onDelete,
  onOpen,
}: {
  artifact: ArtifactSummary;
  deleteReady: boolean;
  deleting: boolean;
  downloadUrl: string;
  loading: boolean;
  onDelete: (artifact: ArtifactSummary) => void;
  onOpen: (artifact: ArtifactSummary) => void;
}) {
  const badge = artifactTypeBadge(artifact);
  return (
    <div className={`project-file-item${deleteReady ? " delete-ready" : ""}${deleting ? " deleting" : ""}`}>
      <button className="project-file-open" type="button" aria-label={`${artifact.name || artifact.path} 열기`} data-tooltip={artifact.name || artifact.path} onClick={() => void onOpen(artifact)}>
        <span className={`artifact-card-icon artifact-card-icon-${badge.tone}`} aria-hidden="true">{badge.label}</span>
        <span className="artifact-card-copy">
          <strong>{artifact.name || artifact.path}</strong>
        </span>
      </button>
      <span className="project-file-actions">
        <button
          className="project-file-delete"
          type="button"
          aria-label={deleteReady ? `${artifact.name} 삭제 확인` : `${artifact.name} 삭제`}
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
        <a className="project-file-download" href={downloadUrl} download={artifact.name} aria-label={`${artifact.name} 다운로드`} data-tooltip="다운로드" onClick={(event) => event.stopPropagation()}>
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
                  <small>{`outputs/${artifact.name || path}`}</small>
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
