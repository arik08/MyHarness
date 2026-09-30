import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ArtifactPanel } from '../../components/ArtifactPanel';
import { artifactAiSelectionMessage } from '../../components/ArtifactPreview';
import { AppStateProvider, useAppState } from '../../state/app-state';
import { initialAppState } from '../../state/reducer';
import { aiEditArtifact, listProjectFiles, overwriteArtifact, readArtifact } from '../../api/artifacts';

vi.mock('../../components/PdfArtifactPreview', () => ({ PdfArtifactPreview: () => <div /> }));
vi.mock('../../api/artifacts', () => ({
  aiEditArtifact: vi.fn(), overwriteArtifact: vi.fn(), readArtifact: vi.fn(),
  deleteArtifact: vi.fn(), renameArtifact: vi.fn(), organizeProjectFiles: vi.fn(),
  listProjectFiles: vi.fn(async () => ({ scope: 'default', files: [] })),
}));
let lastState: typeof initialAppState;
let auditDispatch: ReturnType<typeof useAppState>['dispatch'];
function Probe() { const { state, dispatch } = useAppState(); lastState = state; auditDispatch = dispatch; return <output />; }
const html = '<html><body><h1>Old headline</h1></body></html>';
const activeArtifact = { path: 'outputs/report.html', name: 'report.html', kind: 'html' };
function mountHtml() { return render(<AppStateProvider initialState={{ ...initialAppState, ready: true, artifactPanelOpen: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', clientId: 'fixture', workspacePath: 'C:/fixture', workspaceName: 'fixture', artifacts: [activeArtifact], activeArtifact, activeArtifactPayload: { kind: 'html', content: html } }}><ArtifactPanel /><Probe /></AppStateProvider>); }
function addComment() {
  fireEvent.click(screen.getByRole('button', { name: '본문 수정' }));
  act(() => window.dispatchEvent(new MessageEvent('message', { data: { type: artifactAiSelectionMessage, path: activeArtifact.path, selection: { text: 'Old headline', html: '<h1>Old headline</h1>', start: 0, end: 12, before: '', after: '', instruction: 'Update headline' } } })));
  fireEvent.click(screen.getByRole('button', { name: 'AI 자동편집' }));
}
beforeEach(() => { vi.clearAllMocks(); vi.mocked(readArtifact).mockResolvedValue({ kind: 'html', content: html }); });
afterEach(cleanup);

it('ignores a delayed AI edit acknowledgement after a new chat reuses the runtime', async () => {
  let finish!: (value: Awaited<ReturnType<typeof aiEditArtifact>>) => void;
  vi.mocked(aiEditArtifact).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mountHtml(); addComment();
  await waitFor(() => expect(aiEditArtifact).toHaveBeenCalled());
  act(() => auditDispatch({ type: 'begin_new_chat', sessionId: 'saved-b' }));
  expect(lastState.activeHistoryId).toBe('saved-b'); expect(lastState.busy).toBe(false);
  await act(async () => finish({ ok: true, sourcePath: activeArtifact.path, targetPath: 'outputs/report_v1.html' }));
  expect(lastState.activeHistoryId).toBe('saved-b');
  expect(lastState.busy).toBe(false);
  expect(lastState.artifacts.some(item => item.path === 'outputs/report_v1.html')).toBe(false);
});

it('keeps a completed AI edit idle when its HTTP acknowledgement arrives last', async () => {
  let finish!: (value: Awaited<ReturnType<typeof aiEditArtifact>>) => void;
  vi.mocked(aiEditArtifact).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  mountHtml(); addComment();
  await waitFor(() => expect(aiEditArtifact).toHaveBeenCalled());
  act(() => {
    auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'assistant_complete', message: 'Edit completed' } });
    auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'line_complete' } });
  });
  expect(lastState.busy).toBe(false);
  await act(async () => finish({ ok: true, sourcePath: activeArtifact.path, targetPath: 'outputs/report_v1.html' }));
  expect(lastState.busy).toBe(false);
  expect((screen.getByRole('button', { name: 'AI 자동편집' }) as HTMLButtonElement).disabled).toBe(false);
  await waitFor(() => expect(lastState.activeArtifact?.path).toBe('outputs/report_v1.html'));
});

it.each(['same-runtime', 'new-project'])('ignores a delayed artifact read after leaving the chat (%s)', async (destination) => {
  let finishRead!: (value: Awaited<ReturnType<typeof readArtifact>>) => void;
  vi.mocked(listProjectFiles).mockResolvedValueOnce({ scope: 'default', files: [activeArtifact] });
  vi.mocked(readArtifact).mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve; }));
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, artifactPanelOpen: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', clientId: 'fixture', workspacePath: 'C:/fixture', workspaceName: 'fixture', artifacts: [activeArtifact] }}><ArtifactPanel /><Probe /></AppStateProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'report.html 열기' }));
  await waitFor(() => expect(readArtifact).toHaveBeenCalled());
  act(() => auditDispatch(destination === 'same-runtime'
    ? { type: 'begin_new_chat', sessionId: 'saved-b' }
    : { type: 'session_replaced', sessionId: 'runtime-b', savedSessionId: 'saved-b', workspace: { name: 'project-b', path: 'C:/project-b' } }));
  expect(lastState.artifactPanelOpen).toBe(false); expect(lastState.activeArtifact).toBeNull();
  await act(async () => finishRead({ kind: 'html', content: '<html><body>Old chat private report</body></html>' }));
  expect(lastState.activeHistoryId).toBe('saved-b');
  expect(lastState.artifactPanelOpen).toBe(false);
  expect(lastState.activeArtifact).toBeNull();
  expect(lastState.activeArtifactPayload).toBeNull();
});

it.each(['text', 'markdown', 'json'])('keeps unsupported %s editing read-only without an unsaved draft', async (kind) => {
  const path = `outputs/report.${kind === 'markdown' ? 'md' : kind === 'json' ? 'json' : 'txt'}`;
  const artifact = { path, name: path.split('/').at(-1)!, kind };
  render(<AppStateProvider initialState={{ ...initialAppState, artifactPanelOpen: true, sessionId: 'runtime-a',
    activeArtifact: artifact, activeArtifactPayload: { kind, content: 'Saved text' }, artifacts: [artifact],
  }}><ArtifactPanel /><Probe /></AppStateProvider>);
  if (kind === 'markdown') fireEvent.click(screen.getByRole('button', { name: '소스코드 확인' }));
  const editor = screen.getByRole('textbox') as HTMLTextAreaElement;
  expect(editor.readOnly).toBe(true);
  expect(editor.getAttribute('aria-readonly')).toBe('true');
  expect(screen.getByRole('button', { name: `${artifact.name} 파일명 수정` }).textContent).not.toContain('(편집됨)');
});

it.each(['close', 'other-file'])('releases its busy state on AI edit failure after %s in the same chat', async (destination) => {
  let fail!: (error: Error) => void;
  vi.mocked(aiEditArtifact).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  mountHtml(); addComment();
  expect(lastState.busy).toBe(true);
  act(() => auditDispatch(destination === 'close' ? { type: 'close_artifact' }
    : { type: 'open_artifact', artifact: { path: 'outputs/other.html', kind: 'html' }, payload: { kind: 'html', content: '<html>Other</html>' } }));
  await act(async () => fail(new Error('edit unavailable')));
  expect(lastState.busy).toBe(false);
  expect(lastState.modal).toEqual({ kind: 'error', message: 'edit unavailable' });
});

it.each([false, true])('does not change a newer response when the completed AI edit request settles (failure=%s)', async (failure) => {
  let finish!: (value: Awaited<ReturnType<typeof aiEditArtifact>>) => void;
  let fail!: (error: Error) => void;
  vi.mocked(aiEditArtifact).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  mountHtml(); addComment();
  act(() => auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'line_complete' } }));
  expect(lastState.busy).toBe(false);
  act(() => {
    auditDispatch({ type: 'append_message', message: { role: 'user', text: 'New independent question' } });
    auditDispatch({ type: 'set_busy', value: true });
  });
  await act(async () => failure ? fail(new Error('late old edit failure')) : finish({ ok: true, sourcePath: activeArtifact.path, targetPath: 'outputs/report_v1.html' }));
  expect(lastState.busy).toBe(true);
  expect(lastState.modal).toBeNull();
  expect(lastState.artifacts.some(item => item.path === 'outputs/report_v1.html')).toBe(false);
  expect(lastState.messages.at(-1)?.text).toBe('New independent question');
});
