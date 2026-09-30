import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppContent } from '../App';
import { AppStateProvider, useAppState } from '../state/app-state';
import { initialAppState } from '../state/reducer';
import { listLiveSessions, startSession, shutdownSession } from '../api/session';
import { sendBackendRequest } from '../api/messages';

vi.mock('../hooks/useBackendSession', () => ({ useBackendSession: vi.fn() }));
vi.mock('../hooks/useWorkspaceData', () => ({ useWorkspaceData: vi.fn() }));
vi.mock('../components/AppShell', () => ({ AppShell: () => <main>Fixture shell</main> }));
vi.mock('../api/session', () => ({ listLiveSessions: vi.fn(), startSession: vi.fn(), restartSession: vi.fn(), shutdownSession: vi.fn() }));
vi.mock('../api/messages', () => ({ sendBackendRequest: vi.fn() }));

let current: typeof initialAppState;
let dispatch: ReturnType<typeof useAppState>['dispatch'];
function Probe() { const context = useAppState(); current = context.state; dispatch = context.dispatch; return <output>{current.activeHistoryId}</output>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function select(kind: 'new-chat' | 'saved-chat') {
  act(() => {
    if (kind === 'new-chat') dispatch({ type: 'begin_new_chat', sessionId: 'new-selected' });
    else {
      dispatch({ type: 'begin_history_restore', sessionId: 'saved-selected' });
      dispatch({ type: 'backend_event', event: { type: 'history_snapshot', value: 'saved-selected', preview_only: true, history_events: [{ type: 'assistant', text: 'Selected answer' }] } });
    }
  });
}
function view() { return { sessionId: current.sessionId, activeHistoryId: current.activeHistoryId, pendingHistoryId: current.pendingHistoryId, restoringHistory: current.restoringHistory, busy: current.busy, messages: current.messages, modal: current.modal, workspacePath: current.workspacePath }; }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  window.history.replaceState({}, '', '/?chat=shared-old&workspacePath=C%3A%2Ffixture');
  vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(startSession).mockResolvedValue({ sessionId: 'runtime-shared', workspace: { name: 'Shared', path: 'C:/fixture' } });
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  vi.mocked(shutdownSession).mockResolvedValue({ ok: true });
});
afterEach(() => { cleanup(); window.history.replaceState({}, '', '/'); vi.unstubAllGlobals(); });

it.each(['list', 'runtime', 'resume'] as const)('does not change a newer view after shared restore %s resolves or rejects late', async (stage) => {
  for (const selection of ['new-chat', 'saved-chat'] as const) for (const failure of [false, true]) {
    const list = deferred<Awaited<ReturnType<typeof listLiveSessions>>>();
    const runtime = deferred<Awaited<ReturnType<typeof startSession>>>();
    const resume = deferred<Awaited<ReturnType<typeof sendBackendRequest>>>();
    if (stage === 'list') vi.mocked(listLiveSessions).mockReturnValueOnce(list.promise);
    if (stage === 'runtime') vi.mocked(startSession).mockReturnValueOnce(runtime.promise);
    if (stage === 'resume') vi.mocked(sendBackendRequest).mockReturnValueOnce(resume.promise);
    render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-original', clientId: 'fixture-client', activeHistoryId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Original', messages: [{ id: 'answer-original', role: 'assistant', text: 'Original answer', isComplete: true }] }}><AppContent /><Probe /></AppStateProvider>);
    await waitFor(() => expect(stage === 'list' ? listLiveSessions : stage === 'runtime' ? startSession : sendBackendRequest).toHaveBeenCalled());
    select(selection);
    const expected = view();
    await act(async () => {
      if (stage === 'list') failure ? list.reject(new Error('old shared list error')) : list.resolve({ sessions: [] });
      else if (stage === 'runtime') failure ? runtime.reject(new Error('old shared runtime error')) : runtime.resolve({ sessionId: 'runtime-old-shared', workspace: { name: 'Old shared', path: 'C:/fixture' } });
      else failure ? resume.reject(new Error('old shared resume error')) : resume.resolve({ ok: true });
    });
    expect(view()).toEqual(expected);
    if (stage === 'list') expect(startSession).not.toHaveBeenCalled();
    if (stage !== 'resume') expect(sendBackendRequest).not.toHaveBeenCalled();
    if (stage === 'runtime' && !failure) expect(shutdownSession).toHaveBeenCalledWith('runtime-old-shared', 'fixture-client');
    else expect(shutdownSession).not.toHaveBeenCalled();
    cleanup();
    vi.clearAllMocks();
  }
});

it.each([
  { kind: 'busy-original', busy: true, liveBusy: null, crossWorkspace: false, runtime: 'runtime-shared', starts: 1, resumes: 1 },
  { kind: 'idle-live', busy: false, liveBusy: false, crossWorkspace: false, runtime: 'runtime-live', starts: 0, resumes: 1 },
  { kind: 'busy-live', busy: false, liveBusy: true, crossWorkspace: false, runtime: 'runtime-live', starts: 0, resumes: 0 },
  { kind: 'idle-cross-workspace', busy: false, liveBusy: null, crossWorkspace: true, runtime: 'runtime-shared', starts: 1, resumes: 1 },
])('keeps the normal shared restore path working: $kind', async ({ busy, liveBusy, crossWorkspace, runtime, starts, resumes }) => {
  const target = crossWorkspace ? 'C:/shared-workspace' : 'C:/fixture';
  window.history.replaceState({}, '', `/?chat=shared-old&workspacePath=${encodeURIComponent(target)}`);
  vi.mocked(startSession).mockResolvedValue({ sessionId: 'runtime-shared', workspace: { name: 'Shared', path: target } });
  if (liveBusy !== null) vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [{ sessionId: 'runtime-live', savedSessionId: 'shared-old', busy: liveBusy, createdAt: 1, workspace: { name: 'Shared', path: target } }] });
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy, sessionId: 'runtime-original', clientId: 'fixture-client', activeHistoryId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Original' }}><AppContent /><Probe /></AppStateProvider>);
  await waitFor(() => expect(current.sessionId).toBe(runtime));
  if (resumes) await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledTimes(resumes));
  expect(startSession).toHaveBeenCalledTimes(starts);
  expect(sendBackendRequest).toHaveBeenCalledTimes(resumes);
  if (resumes) expect(sendBackendRequest).toHaveBeenCalledWith(runtime, 'fixture-client', { type: 'apply_select_command', command: 'resume', value: 'shared-old' });
  expect(current.workspacePath).toBe(target);
  expect(current.modal).toBe(null);
  expect(shutdownSession).not.toHaveBeenCalled();
  if (liveBusy) { expect(current.busy).toBe(true); expect(current.restoringHistory).toBe(false); }
});

it('restores the original busy runtime and conversation on a current shared resume failure', async () => {
  const request = deferred<Awaited<ReturnType<typeof sendBackendRequest>>>();
  vi.mocked(sendBackendRequest).mockReturnValueOnce(request.promise);
  const originalMessages = [{ id: 'answer-original', role: 'assistant' as const, text: 'Original answer', isComplete: true }];
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-original', clientId: 'fixture-client', activeHistoryId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Original', messages: originalMessages }}><AppContent /><Probe /></AppStateProvider>);
  await waitFor(() => expect(sendBackendRequest).toHaveBeenCalled());
  await act(async () => request.reject(new Error('current shared resume failed')));
  expect(current.sessionId).toBe('runtime-original');
  expect(current.activeHistoryId).toBe('saved-original');
  expect(current.busy).toBe(true);
  expect(current.restoringHistory).toBe(false);
  expect(current.messages).toMatchObject(originalMessages);
  expect(current.modal).toEqual({ kind: 'error', message: 'current shared resume failed' });
  expect(shutdownSession).toHaveBeenCalledWith('runtime-shared', 'fixture-client');
});

it('ignores a failed acknowledgement after authoritative restore completion and a new turn', async () => {
  const request = deferred<Awaited<ReturnType<typeof sendBackendRequest>>>();
  vi.mocked(sendBackendRequest).mockReturnValueOnce(request.promise);
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-original', clientId: 'fixture-client', activeHistoryId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Original' }}><AppContent /><Probe /></AppStateProvider>);
  await waitFor(() => expect(sendBackendRequest).toHaveBeenCalled());
  act(() => {
    dispatch({ type: 'backend_event', sessionId: 'runtime-shared', event: { type: 'history_snapshot', value: 'shared-old', history_events: [{ type: 'assistant', text: 'Shared answer' }] } });
    dispatch({ type: 'finish_history_restore' });
    dispatch({ type: 'set_busy', value: true });
  });
  const expected = view();
  await act(async () => request.reject(new Error('old shared HTTP acknowledgement failure')));
  expect(view()).toEqual(expected);
});

it('keeps shared restore ownership while the original runtime disconnects before a fresh acknowledgement', async () => {
  const runtime = deferred<Awaited<ReturnType<typeof startSession>>>();
  vi.mocked(startSession).mockReturnValueOnce(runtime.promise);
  render(<AppStateProvider initialState={{ ...initialAppState, ready: true, busy: true, sessionId: 'runtime-original', clientId: 'fixture-client', activeHistoryId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Original' }}><AppContent /><Probe /></AppStateProvider>);
  await waitFor(() => expect(startSession).toHaveBeenCalled());
  act(() => dispatch({ type: 'backend_event', sessionId: 'runtime-original', event: { type: 'shutdown' } }));
  expect(current.restoringHistory).toBe(true);
  expect(current.pendingHistoryId).toBe('shared-old');
  await act(async () => runtime.resolve({ sessionId: 'runtime-shared', workspace: { name: 'Shared', path: 'C:/fixture' } }));
  await waitFor(() => expect(sendBackendRequest).toHaveBeenCalledWith('runtime-shared', 'fixture-client', { type: 'apply_select_command', command: 'resume', value: 'shared-old' }));
  expect(current.sessionId).toBe('runtime-shared');
  expect(shutdownSession).not.toHaveBeenCalled();
});
