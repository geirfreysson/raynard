import { describe, expect, it } from 'vitest';
import { applyStreamPayload, type StreamPayload } from './agent-runtime';

describe('applyStreamPayload', () => {
  it('accumulates answer deltas and provider metadata for the active stream', () => {
    const deltas: string[] = [];
    const payload: StreamPayload = {
      stream_id: 'active',
      event_type: 'delta',
      delta: 'Hello',
      provider: 'moonshot',
      model: 'kimi-k2.5'
    };

    const state = applyStreamPayload(payload, 'active', { streamed: '' }, { onDelta: (delta) => deltas.push(delta) });

    expect(state).toEqual({
      streamed: 'Hello',
      provider: 'moonshot',
      model: 'kimi-k2.5'
    });
    expect(deltas).toEqual(['Hello']);
  });

  it('forwards thinking deltas without adding them to the answer text', () => {
    const thinking: string[] = [];
    const payload: StreamPayload = {
      stream_id: 'active',
      event_type: 'thinking_delta',
      delta: 'planning'
    };

    const state = applyStreamPayload(
      payload,
      'active',
      { streamed: 'Answer', provider: 'moonshot', model: 'kimi-k2.5' },
      { onThinkingDelta: (delta) => thinking.push(delta) }
    );

    expect(state.streamed).toBe('Answer');
    expect(thinking).toEqual(['planning']);
  });

  it('ignores events from other streams', () => {
    const payload: StreamPayload = {
      stream_id: 'other',
      event_type: 'delta',
      delta: 'Wrong'
    };

    const state = applyStreamPayload(payload, 'active', { streamed: 'Right' });

    expect(state.streamed).toBe('Right');
  });
});
