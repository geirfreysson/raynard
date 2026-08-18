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

  it('forwards native tool lifecycle events without adding them to answer text', () => {
    const calls: unknown[] = [];
    const results: unknown[] = [];
    const state = applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'tool_call',
        tool_name: 'getStoryList',
        args: { type: 'top', limit: 15 }
      },
      'active',
      { streamed: 'Looking up stories.' },
      {
        onToolCall: (event) => calls.push(event),
        onToolResult: (event) => results.push(event)
      }
    );

    applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'tool_result',
        tool_name: 'getStoryList',
        args: { type: 'top', limit: 15 },
        result: { text: 'Story one' }
      },
      'active',
      state,
      {
        onToolCall: (event) => calls.push(event),
        onToolResult: (event) => results.push(event)
      }
    );

    expect(state.streamed).toBe('Looking up stories.');
    expect(calls).toEqual([
      {
        toolName: 'getStoryList',
        args: { type: 'top', limit: 15 }
      }
    ]);
    expect(results).toEqual([
      {
        toolName: 'getStoryList',
        args: { type: 'top', limit: 15 },
        result: { text: 'Story one' }
      }
    ]);
  });

  it('forwards a validated available-extension recommendation', () => {
    const recommendations: unknown[] = [];

    applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'extension_recommendation',
        result: {
          slug: 'open-library',
          name: 'Open Library',
          description: 'Search books and authors.',
          answer: 'Open Library can answer that.'
        }
      },
      'active',
      { streamed: '' },
      { onExtensionRecommendation: (recommendation) => recommendations.push(recommendation) }
    );

    expect(recommendations).toEqual([
      {
        slug: 'open-library',
        name: 'Open Library',
        description: 'Search books and authors.',
        answer: 'Open Library can answer that.'
      }
    ]);
  });

  it('forwards complete Pi coding-tool lifecycle events', () => {
    const events: unknown[] = [];
    const handlers = {
      onToolExecutionStart: (event: unknown) => events.push(['start', event]),
      onToolExecutionUpdate: (event: unknown) => events.push(['update', event]),
      onToolExecutionEnd: (event: unknown) => events.push(['end', event])
    };

    applyStreamPayload(
      {
        stream_id: 'builder',
        event_type: 'tool_execution_start',
        tool_call_id: 'call-7',
        tool_name: 'write',
        args: { path: 'index.ts' }
      },
      'builder',
      { streamed: '' },
      handlers
    );
    applyStreamPayload(
      {
        stream_id: 'builder',
        event_type: 'tool_execution_update',
        tool_call_id: 'call-7',
        tool_name: 'write',
        args: { path: 'index.ts' },
        partial_result: { content: [{ type: 'text', text: 'writing' }] }
      },
      'builder',
      { streamed: '' },
      handlers
    );
    applyStreamPayload(
      {
        stream_id: 'builder',
        event_type: 'tool_execution_end',
        tool_call_id: 'call-7',
        tool_name: 'write',
        result: { content: [{ type: 'text', text: 'done' }] },
        is_error: false
      },
      'builder',
      { streamed: '' },
      handlers
    );

    expect(events).toEqual([
      [
        'start',
        {
          toolCallId: 'call-7',
          toolName: 'write',
          args: { path: 'index.ts' }
        }
      ],
      [
        'update',
        {
          toolCallId: 'call-7',
          toolName: 'write',
          args: { path: 'index.ts' },
          partialResult: { content: [{ type: 'text', text: 'writing' }] }
        }
      ],
      [
        'end',
        {
          toolCallId: 'call-7',
          toolName: 'write',
          result: { content: [{ type: 'text', text: 'done' }] },
          isError: false
        }
      ]
    ]);
  });

  it('forwards structured build requests from the main agent', () => {
    const requests: unknown[] = [];

    const state = applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'build_request',
        build_request: {
          name: 'hacker-news',
          description: 'Connect to the Hacker News API',
          sourceUrls: ['https://github.com/HackerNews/API'],
          reason: 'No installed tool can access Hacker News.'
        }
      },
      'active',
      { streamed: '' },
      {
        onBuildRequest: (request) => requests.push(request)
      }
    );

    expect(state.streamed).toBe('');
    expect(requests).toEqual([
      {
        name: 'hacker-news',
        description: 'Connect to the Hacker News API',
        sourceUrls: ['https://github.com/HackerNews/API'],
        reason: 'No installed tool can access Hacker News.'
      }
    ]);
  });

  it('dispatches a credential request carried in the generic result field', () => {
    const requests: unknown[] = [];

    applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'credential_request',
        result: {
          pluginId: 'open-weather',
          pluginName: 'Open Weather',
          credentials: [
            {
              key: 'OPENWEATHER_API_KEY',
              label: 'OpenWeather API key',
              signupUrl: 'https://openweathermap.org/api'
            }
          ]
        }
      },
      'active',
      { streamed: '' },
      { onCredentialRequest: (request) => requests.push(request) }
    );

    expect(requests).toEqual([
      {
        pluginId: 'open-weather',
        pluginName: 'Open Weather',
        credentials: [
          {
            key: 'OPENWEATHER_API_KEY',
            label: 'OpenWeather API key',
            description: '',
            signupUrl: 'https://openweathermap.org/api'
          }
        ]
      }
    ]);
  });

  it('ignores a malformed credential request rather than half-rendering a card', () => {
    const requests: unknown[] = [];

    applyStreamPayload(
      { stream_id: 'active', event_type: 'credential_request', result: { credentials: [] } },
      'active',
      { streamed: '' },
      { onCredentialRequest: (request) => requests.push(request) }
    );

    expect(requests).toEqual([]);
  });

  it('ignores a credential request from a superseded stream', () => {
    const requests: unknown[] = [];

    applyStreamPayload(
      {
        stream_id: 'stale',
        event_type: 'credential_request',
        result: {
          pluginId: 'open-weather',
          credentials: [{ key: 'OPENWEATHER_API_KEY', label: 'Key' }]
        }
      },
      'active',
      { streamed: '' },
      { onCredentialRequest: (request) => requests.push(request) }
    );

    expect(requests).toEqual([]);
  });

  it('reports a resume attempt so the turn can say it is waiting, not hung', () => {
    const retries: unknown[] = [];

    applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'retry',
        error: '429 The engine is currently overloaded',
        retry: { reason: 'overloaded', attempt: 2, maxAttempts: 3, delayMs: 6000 }
      },
      'active',
      { streamed: 'partial' },
      { onRetry: (event) => retries.push(event) }
    );

    expect(retries).toEqual([
      {
        reason: 'overloaded',
        attempt: 2,
        maxAttempts: 3,
        delayMs: 6000,
        error: '429 The engine is currently overloaded'
      }
    ]);
  });

  it('carries provider identity out of the error event, which the command drops', () => {
    // invoke() rejects with a bare string, so this event is the only place the
    // renderer can learn whose failure it was.
    const errors: unknown[] = [];

    applyStreamPayload(
      {
        stream_id: 'active',
        event_type: 'error',
        error: '429 The engine is currently overloaded (stopReason: error)',
        provider: 'moonshot',
        model: 'kimi-k2.5',
        retry: { resumeAttempts: 3 }
      },
      'active',
      { streamed: '' },
      { onError: (event) => errors.push(event) }
    );

    expect(errors).toEqual([
      {
        error: '429 The engine is currently overloaded (stopReason: error)',
        provider: 'moonshot',
        model: 'kimi-k2.5',
        resumeAttempts: 3
      }
    ]);
  });

  it('reports zero resumes when the sidecar never retried', () => {
    const errors: { resumeAttempts: number }[] = [];

    applyStreamPayload(
      { stream_id: 'active', event_type: 'error', error: '401 Invalid Authentication' },
      'active',
      { streamed: '' },
      { onError: (event) => errors.push(event) }
    );

    expect(errors[0].resumeAttempts).toBe(0);
  });

  it('dispatches a builder status milestone', () => {
    const seen: string[] = [];

    applyStreamPayload(
      { stream_id: 'active', event_type: 'status', text: 'running_tests:tools.test.ts' },
      'active',
      { streamed: '' },
      { onStatus: (status) => seen.push(status) }
    );

    expect(seen).toEqual(['running_tests:tools.test.ts']);
  });

  it('ignores an empty status and one from a superseded stream', () => {
    const seen: string[] = [];
    const handlers = { onStatus: (status: string) => seen.push(status) };

    applyStreamPayload(
      { stream_id: 'active', event_type: 'status', text: '   ' },
      'active',
      { streamed: '' },
      handlers
    );
    applyStreamPayload(
      { stream_id: 'stale', event_type: 'status', text: 'builder_started' },
      'active',
      { streamed: '' },
      handlers
    );

    expect(seen).toEqual([]);
  });
});
