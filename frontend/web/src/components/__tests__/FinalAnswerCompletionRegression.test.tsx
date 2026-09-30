import { cleanup, render } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { MessageList } from '../../components/MessageList';
import { AppStateProvider } from '../../state/app-state';
import { appReducer, initialAppState } from '../../state/reducer';
import type { BackendEvent } from '../../types/backend';

afterEach(cleanup);
it('renders a final-only completion matching earlier tool commentary', () => {
  const text = 'Confirmed result.';
  let state = appReducer({ ...initialAppState, sessionId: 'fixture-runtime', ready: true }, { type: 'append_message', message: { role: 'user', text: 'Check result' } });
  const events: BackendEvent[] = [
    { type: 'assistant_delta', message: text },
    { type: 'assistant_complete', message: text, has_tool_uses: true },
    { type: 'tool_started', tool_name: 'mcp__fixture__verify', tool_call_id: 'verification' },
    { type: 'tool_completed', tool_name: 'mcp__fixture__verify', tool_call_id: 'verification', output: 'verified', is_error: false },
    { type: 'assistant_complete', message: text, has_tool_uses: false },
    { type: 'line_complete' },
  ];
  for (const event of events) state = appReducer(state, { type: 'backend_event', sessionId: 'fixture-runtime', event });
  expect(state.busy).toBe(false);
  expect(state.messages.filter(message => message.role === 'assistant')).toHaveLength(2);
  expect(state.messages.at(-1)?.responsePhase).not.toBe('commentary');
  const { container } = render(<AppStateProvider initialState={state}><MessageList /></AppStateProvider>);
  expect(container.querySelectorAll('.message.assistant:not(.aside-workflow)')).toHaveLength(1);
  expect(container.textContent).toContain(text);
});
