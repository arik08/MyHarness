import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Sidebar } from '../../components/Sidebar';
import { Composer } from '../../components/Composer';
import { MessageList } from '../../components/MessageList';
import { AppStateProvider, useAppState } from '../../state/app-state';
import { initialAppState } from '../../state/reducer';
import { loadHistorySnapshot } from '../../api/history';
import { listLiveSessions, startSession, restartSession, shutdownSession } from '../../api/session';
import { sendBackendRequest, sendMessage } from '../../api/messages';

vi.mock('../../api/session', () => ({ capacityQueueStatusEvent: 'queue', listLiveSessions: vi.fn(), startSession: vi.fn(), restartSession: vi.fn(), shutdownSession: vi.fn() }));
vi.mock('../../api/history', () => ({ historyPageSize: 25, loadHistorySnapshot: vi.fn(), listHistory: vi.fn(), deleteHistory: vi.fn(), hideHistory: vi.fn(), restoreHistory: vi.fn(), updateHistoryTitle: vi.fn(), toggleHistoryPin: vi.fn(), toggleHistoryLike: vi.fn(), moveHistory: vi.fn() }));
vi.mock('../../api/messages', () => ({ sendBackendRequest: vi.fn(), sendMessage: vi.fn(), enhancePrompt: vi.fn(), cancelMessage: vi.fn(), uploadClientAttachments: vi.fn() }));

let lastState: typeof initialAppState;
let auditDispatch: ReturnType<typeof useAppState>['dispatch'];
function Probe() { const { state, dispatch } = useAppState(); lastState = state; auditDispatch = dispatch; return <output data-testid="audit-view">{lastState.activeHistoryId}|{lastState.workspacePath}|{lastState.sessionId}|{String(lastState.busy)}</output>; }
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadHistorySnapshot).mockResolvedValue({ type: 'history_snapshot', value: 'saved-b', message: 'B saved chat', preview_only: true, history_events: [{ type: 'user', text: 'B question' }, { type: 'assistant', text: 'B answer' }] });
  vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(startSession).mockResolvedValue({ sessionId: 'runtime-b' });
  vi.mocked(shutdownSession).mockResolvedValue({ ok: true });
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  vi.mocked(sendMessage).mockResolvedValue({ ok: true });
});
afterEach(cleanup);

it('routes a cross-workspace preview follow-up to its own runtime and workspace', async () => {
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', workspaceName: 'A', workspacePath: 'C:/a', history: [{ value: 'saved-b', label: 'B saved chat', workspace: { name: 'B', path: 'C:/b' } }] }}><Sidebar /><Composer /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'B saved chat' }));
  await waitFor(() => expect(lastState.activeHistoryId).toBe('saved-b'));
  await waitFor(() => expect(lastState.restoringHistory).toBe(false));
  expect(lastState.workspacePath).toBe('C:/b');
  expect(lastState.sessionId).toBe('runtime-b');
  expect(startSession).toHaveBeenCalled();
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Continue B' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-b', workspacePath: 'C:/b', resumeSessionId: 'saved-b' }));
});

it('separates a busy backend before enabling a saved preview follow-up', async () => {
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', workspaceName: 'A', workspacePath: 'C:/a', history: [{ value: 'saved-b', label: 'B saved chat' }] }}><Sidebar /><Composer /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'B saved chat' }));
  await waitFor(() => expect(lastState.activeHistoryId).toBe('saved-b'));
  await waitFor(() => expect(lastState.restoringHistory).toBe(false));
  expect(lastState.busy).toBe(false);
  expect(lastState.sessionId).toBe('runtime-b');
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Continue B' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-b', resumeSessionId: 'saved-b' }));
  expect(startSession).toHaveBeenCalled();
});

it('ignores the original runtime response before and after a saved-chat follow-up', async () => {
  let rejectSend!: (error: Error) => void;
  vi.mocked(sendMessage).mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectSend = reject; }));
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', workspaceName: 'A', workspacePath: 'C:/a', history: [{ value: 'saved-b', label: 'B saved chat' }], messages: [{ id: 'a-user', role: 'user', text: 'A original question' }] }}><Sidebar /><Composer /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'B saved chat' }));
  await waitFor(() => expect(lastState.restoringHistory).toBe(false));
  act(() => auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'assistant_delta', message: 'A read-only token' } }));
  expect(lastState.messages.map(item => item.text)).toEqual(['B question', 'B answer']);
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Continue B' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sendMessage).toHaveBeenCalled());
  act(() => auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'assistant_delta', message: 'A unrelated response secret' } }));
  expect(lastState.activeHistoryId).toBe('saved-b');
  expect(lastState.messages.map(item => item.text)).toEqual(['B question', 'B answer', 'Continue B']);
  await act(async () => rejectSend(new Error('HTTP 409: current response is busy')));
  expect(lastState.messages.some(item => item.text === 'A unrelated response secret')).toBe(false);
});

it('ignores a delayed restart after a newer saved conversation selection', async () => {
  let finishRestart!: (value: { sessionId: string }) => void;
  vi.mocked(restartSession).mockImplementationOnce(() => new Promise(resolve => { finishRestart = resolve; }));
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', workspaceName: 'A', workspacePath: 'C:/a', history: [{ value: 'saved-b', label: 'B saved chat' }] }}><Sidebar /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: '재시작' }));
  expect(screen.getByRole('button', { name: '재시작' }).getAttribute('aria-busy')).toBe('true');
  expect((screen.getByRole('button', { name: '새 대화' }) as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: '재시작' }));
  await waitFor(() => expect(restartSession).toHaveBeenCalled());
  expect(restartSession).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'B saved chat' }));
  await waitFor(() => expect(lastState.activeHistoryId).toBe('saved-b'));
  await waitFor(() => expect(lastState.restoringHistory).toBe(false));
  expect(screen.getByRole('button', { name: '재시작' }).getAttribute('aria-busy')).toBe('false');
  await act(async () => finishRestart({ sessionId: 'restarted-a' }));
  expect(lastState.sessionId).toBe('runtime-b');
  expect(lastState.activeHistoryId).toBe('saved-b');
  expect(lastState.messages.map(item => item.text)).toEqual(['B question', 'B answer']);
  expect(shutdownSession).toHaveBeenCalledWith('restarted-a', lastState.clientId);
});

it.each([false, true])('shows the preview immediately and waits for a safe runtime before sending (failure=%s)', async (failure) => {
  let finish!: (value: { sessionId: string }) => void;
  let fail!: (error: Error) => void;
  vi.mocked(startSession).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a',
    workspaceName: 'A', workspacePath: 'C:/a', messages: [{ id: 'a-question', role: 'user', text: 'Original running question' }],
    history: [{ value: 'saved-b', label: 'B saved chat' }],
  }}><Sidebar /><MessageList /><Composer /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: 'B saved chat' }));
  await waitFor(() => expect(startSession).toHaveBeenCalled());
  await act(async () => new Promise(resolve => window.setTimeout(resolve, 50)));
  expect(lastState.messages.map(item => item.text)).toEqual(['B question', 'B answer']);
  expect(lastState.restoringHistory).toBe(true);
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Continue B' } });
  expect((screen.getByRole('button', { name: '메시지 보내기' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(input.closest('form')!);
  expect(sendMessage).not.toHaveBeenCalled();
  await act(async () => failure ? fail(new Error('runtime unavailable')) : finish({ sessionId: 'runtime-b' }));
  expect(lastState.restoringHistory).toBe(false);
  if (failure) {
    expect(lastState.sessionId).toBe('runtime-a');
    expect(lastState.activeHistoryId).toBe('saved-a');
    expect(lastState.busy).toBe(true);
    expect(lastState.messages.map(item => item.text)).toEqual(['Original running question']);
    expect(lastState.modal).toEqual({ kind: 'error', message: 'runtime unavailable' });
  } else {
    fireEvent.submit(input.closest('form')!);
    await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-b', resumeSessionId: 'saved-b', workspacePath: 'C:/a' })));
  }
});

it('blocks a restarting runtime and adopts its replacement for a newer chat after the old stream closes', async () => {
  let finishRestart!: (value: { sessionId: string }) => void;
  vi.mocked(restartSession).mockImplementationOnce(() => new Promise(resolve => { finishRestart = resolve; }));
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', clientId: 'client-1', workspaceName: 'A', workspacePath: 'C:/a' }}><Sidebar /><Composer /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: '재시작' }));
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Before runtime is replaced' } });
  fireEvent.submit(input.closest('form')!);
  expect(sendMessage).not.toHaveBeenCalled();
  act(() => auditDispatch({ type: 'begin_new_chat', sessionId: 'new-chat' }));
  fireEvent.change(input, { target: { value: 'New draft stays here' } });
  fireEvent.submit(input.closest('form')!);
  expect(sendMessage).not.toHaveBeenCalled();
  act(() => auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'shutdown' } }));
  expect(lastState.sessionId).toBeNull();
  await act(async () => finishRestart({ sessionId: 'runtime-restarted' }));
  expect(lastState.sessionId).toBe('runtime-restarted');
  expect(lastState.activeHistoryId).toBe('new-chat');
  expect(lastState.composer.draft).toBe('New draft stays here');
  expect(lastState.restartingSessionId).toBeNull();
  expect(shutdownSession).not.toHaveBeenCalled();
  act(() => auditDispatch({ type: 'backend_event', sessionId: 'runtime-restarted', event: { type: 'ready', state: {} } }));
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-restarted', line: 'New draft stays here' })));
});

it('finishes a saved preview after the restarting source stream closes during its new-runtime handoff', async () => {
  let finishRestart!: (value: { sessionId: string }) => void;
  let finishStart!: (value: { sessionId: string }) => void;
  vi.mocked(restartSession).mockImplementationOnce(() => new Promise(resolve => { finishRestart = resolve; }));
  vi.mocked(startSession).mockImplementationOnce(() => new Promise(resolve => { finishStart = resolve; }));
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, sessionId: 'runtime-a', activeHistoryId: 'saved-a', clientId: 'client-1', workspaceName: 'A', workspacePath: 'C:/a', history: [{ value: 'saved-b', label: 'B saved chat' }] }}><Sidebar /><MessageList /><Composer /><Probe /></AppStateProvider>);
  fireEvent.click(screen.getByRole('button', { name: '재시작' }));
  fireEvent.click(screen.getByRole('button', { name: 'B saved chat' }));
  await waitFor(() => expect(startSession).toHaveBeenCalled());
  act(() => auditDispatch({ type: 'backend_event', sessionId: 'runtime-a', event: { type: 'shutdown' } }));
  expect(lastState.pendingHistoryId).toBe('saved-b');
  expect(lastState.restoringHistory).toBe(true);
  expect(lastState.messages.map(item => item.text)).toEqual(['B question', 'B answer']);
  await act(async () => finishStart({ sessionId: 'runtime-b' }));
  expect(lastState.sessionId).toBe('runtime-b');
  expect(lastState.activeHistoryId).toBe('saved-b');
  expect(lastState.restoringHistory).toBe(false);
  await act(async () => finishRestart({ sessionId: 'unused-restart' }));
  expect(shutdownSession).toHaveBeenCalledWith('unused-restart', 'client-1');
  expect(lastState.sessionId).toBe('runtime-b');
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Continue B after restart' } });
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-b', resumeSessionId: 'saved-b' })));
});
