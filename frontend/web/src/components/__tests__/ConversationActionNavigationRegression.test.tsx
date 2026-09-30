import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppContent } from '../../App';
import { AssistantActions } from '../AssistantActions';
import { Composer } from '../Composer';
import { AppStateProvider, useAppState } from '../../state/app-state';
import { initialAppState } from '../../state/reducer';
import { restartSession, startSession, shutdownSession } from '../../api/session';
import { sendMessage } from '../../api/messages';
import { branchHistory } from '../../api/branch';
import { loadHistorySnapshot } from '../../api/history';
import type { ChatMessage } from '../../types/ui';

vi.mock('../../hooks/useBackendSession', () => ({ useBackendSession: vi.fn() }));
vi.mock('../../hooks/useWorkspaceData', () => ({ useWorkspaceData: vi.fn() }));
vi.mock('../AppShell', () => ({ AppShell: () => <main>app shell</main> }));
vi.mock('../ResponseFeedback', () => ({ ResponseFeedback: () => null }));
vi.mock('../../api/session', () => ({ restartSession: vi.fn(), startSession: vi.fn(), listLiveSessions: vi.fn(), shutdownSession: vi.fn() }));
vi.mock('../../api/messages', () => ({ sendBackendRequest: vi.fn(), sendMessage: vi.fn(), enhancePrompt: vi.fn(), cancelMessage: vi.fn(), uploadClientAttachments: vi.fn() }));
vi.mock('../../api/branch', () => ({ branchHistory: vi.fn() }));
vi.mock('../../api/history', () => ({ loadHistorySnapshot: vi.fn() }));

const answer: ChatMessage = { id: 'a-answer', role: 'assistant', text: 'A answer', isComplete: true };
const workspace = { name: 'A', path: 'C:/fixture-a' };
const branch = { sessionId: 'saved-child', title: 'A branch', workspace };
let current: typeof initialAppState;
let dispatch: ReturnType<typeof useAppState>['dispatch'];
function Probe() { const context = useAppState(); current = context.state; dispatch = context.dispatch; return <output>{current.activeHistoryId}</output>; }
function mount(shortcut = false, composer = false) {
  return render(<AppStateProvider initialState={{ ...initialAppState, ready: true, sessionId: 'runtime-a', clientId: 'client', activeHistoryId: 'saved-a', workspacePath: workspace.path, workspaceName: workspace.name, messages: [answer] }}>
    {shortcut ? <AppContent /> : <AssistantActions message={answer} />}{composer && <Composer />}<Probe />
  </AppStateProvider>);
}
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function selectNewView(kind: 'new-chat' | 'saved-chat') {
  act(() => {
    if (kind === 'new-chat') dispatch({ type: 'begin_new_chat', sessionId: 'new-view' });
    else {
      dispatch({ type: 'begin_history_restore', sessionId: 'saved-b' });
      dispatch({ type: 'backend_event', event: { type: 'history_snapshot', value: 'saved-b', message: 'B selected', preview_only: true, history_events: [{ type: 'assistant', text: 'B answer' }] } });
    }
  });
}
function view() { return { sessionId: current.sessionId, activeHistoryId: current.activeHistoryId, messages: current.messages, restoringHistory: current.restoringHistory, busy: current.busy, modal: current.modal, workspacePath: current.workspacePath }; }
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  vi.mocked(branchHistory).mockResolvedValue(branch);
  vi.mocked(shutdownSession).mockResolvedValue({ ok: true });
  vi.mocked(sendMessage).mockResolvedValue({ ok: true });
  vi.mocked(startSession).mockResolvedValue({ sessionId: 'runtime-child', workspace });
  vi.mocked(loadHistorySnapshot).mockResolvedValue({ type: 'history_snapshot', value: branch.sessionId, message: branch.title, preview_only: true, history_events: [{ type: 'assistant', text: 'Child answer' }] });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it.each(['new-chat', 'saved-chat'] as const)('ignores shortcut restart success and failure after %s selection', async (selection) => {
  for (const failure of [false, true]) {
    const request = deferred<{ sessionId: string }>();
    vi.mocked(restartSession).mockReturnValueOnce(request.promise);
    mount(true);
    fireEvent.keyDown(window, { key: 'O', ctrlKey: true, shiftKey: true });
    expect(restartSession).toHaveBeenCalled();
    selectNewView(selection);
    const expected = view();
    await act(async () => failure ? request.reject(new Error('old restart failure')) : request.resolve({ sessionId: 'old-restarted-a' }));
    expect(view()).toEqual(!failure && selection === 'new-chat' ? { ...expected, sessionId: 'old-restarted-a' } : expected);
    if (!failure && selection === 'saved-chat') expect(shutdownSession).toHaveBeenCalledWith('old-restarted-a', 'client');
    cleanup();
  }
});

it('blocks sending to a restarting runtime and preserves a newer chat while adopting the replacement', async () => {
  const request = deferred<{ sessionId: string }>();
  vi.mocked(restartSession).mockReturnValueOnce(request.promise);
  mount(true, true);
  fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });
  expect(current.restartingSessionId).toBe('runtime-a');
  const input = document.querySelector('#promptInput') as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Unsafe before restart' } });
  expect((screen.getByRole('button', { name: '메시지 보내기' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.submit(input.closest('form')!);
  expect(sendMessage).not.toHaveBeenCalled();
  selectNewView('new-chat');
  fireEvent.change(input, { target: { value: 'New conversation input' } });
  fireEvent.submit(input.closest('form')!);
  expect(sendMessage).not.toHaveBeenCalled();
  const messages = current.messages;
  await act(async () => request.resolve({ sessionId: 'runtime-restarted' }));
  expect(current.sessionId).toBe('runtime-restarted');
  expect(current.activeHistoryId).toBe('new-view');
  expect(current.messages).toEqual(messages);
  expect(current.composer.draft).toBe('New conversation input');
  expect(current.restartingSessionId).toBeNull();
  expect(shutdownSession).not.toHaveBeenCalled();
  fireEvent.submit(input.closest('form')!);
  await waitFor(() => expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'runtime-restarted', line: 'New conversation input' })));
});

it('releases a fresh branch runtime that arrives after snapshot failure', async () => {
  const request = deferred<{ sessionId: string; workspace: typeof workspace }>();
  vi.mocked(startSession).mockReturnValueOnce(request.promise);
  vi.mocked(loadHistorySnapshot).mockRejectedValueOnce(new Error('missing snapshot'));
  mount();
  fireEvent.click(screen.getByRole('button', { name: '이 답변까지 새 채팅으로 분기' }));
  await waitFor(() => expect(current.modal).toMatchObject({ kind: 'error', message: '분기 실패: missing snapshot' }));
  await act(async () => request.resolve({ sessionId: 'unused-child', workspace }));
  expect(shutdownSession).toHaveBeenCalledTimes(1);
  expect(shutdownSession).toHaveBeenCalledWith('unused-child', 'client');
  expect(current.sessionId).toBe('runtime-a');
});

it('locks repeated shortcut requests immediately and restores availability on current-view failure', async () => {
  const request = deferred<{ sessionId: string }>();
  vi.mocked(restartSession).mockReturnValueOnce(request.promise);
  mount(true);
  fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });
  fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });
  expect(restartSession).toHaveBeenCalledTimes(1);
  await act(async () => request.reject(new Error('current restart failure')));
  expect(current.modal).toMatchObject({ kind: 'error', message: 'current restart failure' });
  expect(current.sessionId).toBe('runtime-a');
  vi.mocked(restartSession).mockResolvedValueOnce({ sessionId: 'runtime-restarted' });
  fireEvent.keyDown(window, { key: 'o', ctrlKey: true, shiftKey: true });
  await waitFor(() => expect(current.sessionId).toBe('runtime-restarted'));
});

it.each(['new-chat', 'saved-chat'] as const)('ignores branch callbacks at both awaits after %s selection', async (selection) => {
  for (const stage of ['branch', 'runtime'] as const) for (const failure of [false, true]) {
    const branchRequest = deferred<typeof branch>();
    const runtimeRequest = deferred<{ sessionId: string; workspace: typeof workspace }>();
    if (stage === 'branch') vi.mocked(branchHistory).mockReturnValueOnce(branchRequest.promise);
    else vi.mocked(startSession).mockReturnValueOnce(runtimeRequest.promise);
    mount();
    fireEvent.click(screen.getByRole('button', { name: '이 답변까지 새 채팅으로 분기' }));
    if (stage === 'runtime') await waitFor(() => expect(startSession).toHaveBeenCalled());
    selectNewView(selection);
    const expected = view();
    await act(async () => {
      if (stage === 'branch') failure ? branchRequest.reject(new Error('old branch failure')) : branchRequest.resolve(branch);
      else failure ? runtimeRequest.reject(new Error('old runtime failure')) : runtimeRequest.resolve({ sessionId: 'runtime-child', workspace });
    });
    expect(view()).toEqual(expected);
    cleanup();
    vi.clearAllMocks();
  }
});

it('shows branch progress immediately, prevents duplicates, and releases the control on failure', async () => {
  const request = deferred<typeof branch>();
  vi.mocked(branchHistory).mockReturnValueOnce(request.promise);
  mount();
  const button = screen.getByRole('button', { name: '이 답변까지 새 채팅으로 분기' });
  fireEvent.click(button);
  expect(button.getAttribute('aria-busy')).toBe('true');
  expect(screen.getByText('새 채팅으로 분기 중...').getAttribute('role')).toBe('status');
  fireEvent.click(button);
  expect(branchHistory).toHaveBeenCalledTimes(1);
  await act(async () => request.reject(new Error('current branch failure')));
  expect((button as HTMLButtonElement).disabled).toBe(false);
  expect(current.modal).toMatchObject({ kind: 'error', message: '분기 실패: current branch failure' });
  expect(current.restoringHistory).toBe(false);
  expect(current.sessionId).toBe('runtime-a');
});
