import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppStateProvider, useAppState } from '../../state/app-state';
import { initialAppState } from '../../state/reducer';
import { useBackendSession } from '../../hooks/useBackendSession';
import { listLiveSessions, startSession } from '../../api/session';
import { loadHistorySnapshot } from '../../api/history';
import { sendBackendRequest } from '../../api/messages';
import { openBackendEvents } from '../../api/events';

vi.mock('../../api/session', () => ({ capacityQueueStatusEvent: 'fixture-capacity', listLiveSessions: vi.fn(), startSession: vi.fn() }));
vi.mock('../../api/history', () => ({ loadHistorySnapshot: vi.fn() }));
vi.mock('../../api/messages', () => ({ sendBackendRequest: vi.fn() }));
vi.mock('../../api/events', () => ({ openBackendEvents: vi.fn(() => ({ close: vi.fn() })) }));
let current: typeof initialAppState;
let dispatch: ReturnType<typeof useAppState>['dispatch'];
function Probe() { useBackendSession(); const context = useAppState(); current = context.state; dispatch = context.dispatch; return <output>{current.sessionId || 'disconnected'}</output>; }
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear(); sessionStorage.clear();
  localStorage.setItem('myharness:lastConversation', JSON.stringify({ sessionId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Fixture' }));
  vi.mocked(listLiveSessions).mockResolvedValue({ sessions: [] });
  vi.mocked(startSession).mockResolvedValue({ sessionId: 'runtime-boot', workspace: { path: 'C:/fixture', name: 'Fixture' } });
  vi.mocked(sendBackendRequest).mockResolvedValue({ ok: true });
  vi.mocked(loadHistorySnapshot).mockImplementation(async ({ sessionId }) => ({ type: 'history_snapshot', value: sessionId, preview_only: true, history_events: [{ type: 'assistant', text: `Answer for ${sessionId}` }] }));
  vi.mocked(openBackendEvents).mockImplementation(() => ({ close: vi.fn() }) as unknown as EventSource);
});
afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear(); });

it.each([
  { restoringHistory: true, pendingHistoryId: 'saved-selected' },
  { restoringHistory: true, pendingHistoryId: null },
  { restoringHistory: false, pendingHistoryId: 'saved-selected' },
])('delegates disconnected bootstrap to a pending restore owner and resumes after completion (%o)', async ({ restoringHistory, pendingHistoryId }) => {
  render(<AppStateProvider initialState={{ ...initialAppState, clientId: 'fixture-client', sessionId: null, activeHistoryId: 'saved-selected', workspacePath: 'C:/fixture', workspaceName: 'Fixture', historyReadOnly: true, restoringHistory, pendingHistoryId, messages: [{ id: 'selected-answer', role: 'assistant', text: 'Selected answer', isComplete: true }] }}><Probe /></AppStateProvider>);
  await act(async () => new Promise(resolve => window.setTimeout(resolve, 20)));
  expect(listLiveSessions).not.toHaveBeenCalled();
  expect(loadHistorySnapshot).not.toHaveBeenCalled();
  expect(startSession).not.toHaveBeenCalled();
  expect(sendBackendRequest).not.toHaveBeenCalled();
  expect(current.messages.map(item => item.text)).toEqual(['Selected answer']);
  act(() => dispatch({ type: 'finish_history_restore' }));
  await waitFor(() => expect(current.sessionId).toBe('runtime-boot'));
  expect(loadHistorySnapshot).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'saved-selected' }));
  expect(sendBackendRequest).toHaveBeenCalledWith('runtime-boot', 'fixture-client', { type: 'apply_select_command', command: 'resume', value: 'saved-selected' });
  expect(current.messages.map(item => item.text)).toEqual(['Selected answer']);
});

it('resumes normal bootstrap of the original conversation after the pending owner fails disconnected', async () => {
  render(<AppStateProvider initialState={{ ...initialAppState, clientId: 'fixture-client', sessionId: null, activeHistoryId: 'saved-original', workspacePath: 'C:/fixture', workspaceName: 'Fixture', historyReadOnly: true, restoringHistory: true, pendingHistoryId: 'saved-unavailable' }}><Probe /></AppStateProvider>);
  await act(async () => new Promise(resolve => window.setTimeout(resolve, 20)));
  expect(startSession).not.toHaveBeenCalled();
  act(() => { dispatch({ type: 'open_modal', modal: { kind: 'error', message: 'Restore failed' } }); dispatch({ type: 'finish_history_restore' }); });
  await waitFor(() => expect(current.sessionId).toBe('runtime-boot'));
  expect(loadHistorySnapshot).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'saved-original' }));
  expect(sendBackendRequest).toHaveBeenCalledWith('runtime-boot', 'fixture-client', { type: 'apply_select_command', command: 'resume', value: 'saved-original' });
});

it('accepts a runtime supplied by the pending owner without starting a competing runtime', async () => {
  render(<AppStateProvider initialState={{ ...initialAppState, clientId: 'fixture-client', sessionId: null, activeHistoryId: 'saved-selected', workspacePath: 'C:/fixture', workspaceName: 'Fixture', historyReadOnly: true, restoringHistory: true, pendingHistoryId: 'saved-selected' }}><Probe /></AppStateProvider>);
  await act(async () => new Promise(resolve => window.setTimeout(resolve, 20)));
  act(() => { dispatch({ type: 'session_started', sessionId: 'runtime-owned', clientId: 'fixture-client' }); dispatch({ type: 'finish_history_restore' }); });
  await waitFor(() => expect(openBackendEvents).toHaveBeenCalled());
  expect(current.sessionId).toBe('runtime-owned');
  expect(startSession).not.toHaveBeenCalled();
  expect(loadHistorySnapshot).not.toHaveBeenCalled();
  expect(sendBackendRequest).not.toHaveBeenCalled();
});
