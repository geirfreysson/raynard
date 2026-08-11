import { describe, expect, it } from 'vitest';
import { Agent } from '@mariozechner/pi-agent-core';
import { createAssistantMessageEventStream } from '@mariozechner/pi-ai';
import { runWithTransientResume } from './main-agent-core.mjs';

/**
 * Resume against the real Pi Agent, not a stand-in.
 *
 * The resume works by deleting the empty assistant message a failed round leaves
 * behind and calling `agent.continue()`. That depends on undocumented
 * pi-agent-core behaviour — that the errored message lands in the transcript,
 * and that continuing from a trailing tool result re-runs the failed round
 * rather than restarting the turn. A dependency upgrade could change either
 * silently, so it is pinned here with a scripted provider instead of mocks.
 */

const MODEL = {
  id: 'kimi-k2.5',
  name: 'test model',
  api: 'openai-completions',
  provider: 'moonshot',
  baseUrl: 'https://example.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 100000,
  maxTokens: 4096
};

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
};

function assistantMessage(extra) {
  return {
    role: 'assistant',
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: EMPTY_USAGE,
    timestamp: Date.now(),
    ...extra
  };
}

const OVERLOADED = '429 The engine is currently overloaded, please try again later';

/** An agent whose provider replays `rounds`, one per model call. */
function scriptedAgent(rounds) {
  let round = 0;
  const streamFn = (_model, context) => {
    const stream = createAssistantMessageEventStream();
    const produce = rounds[round++] || (() => assistantMessage({ content: [], stopReason: 'stop' }));
    const message = produce(context);
    queueMicrotask(() => {
      stream.push({ type: 'start', partial: message });
      if (message.stopReason === 'error') {
        stream.push({ type: 'error', reason: 'error', error: message });
      } else {
        stream.push({ type: 'done', reason: message.stopReason, message });
      }
    });
    return stream;
  };

  const agent = new Agent({
    initialState: {
      systemPrompt: 'test',
      model: MODEL,
      thinkingLevel: 'off',
      tools: [
        {
          name: 'eia_route_details',
          description: 'test tool',
          parameters: { type: 'object', properties: {} },
          execute: async () => ({ output: 'rows', details: {} })
        }
      ],
      messages: []
    },
    getApiKey: async () => 'test-key',
    streamFn,
    toolExecution: 'sequential'
  });

  const observed = { stopReason: '', errorMessage: '', text: '' };
  agent.subscribe((event) => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') {
      observed.stopReason = String(event.message.stopReason || '');
      observed.errorMessage = String(event.message.errorMessage || '');
      const text = (event.message.content || [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text) observed.text = text;
    }
  });

  return { agent, observed };
}

function resume(agent, observed, prompt = 'what about european natural gas prices?') {
  const retries = [];
  return runWithTransientResume({
    agent,
    start: () => agent.prompt(prompt),
    readFailure: () => observed,
    onResume: (event) => retries.push(event),
    resetRound: () => {
      observed.stopReason = '';
      observed.errorMessage = '';
    },
    wait: async () => {}
  }).then((result) => ({ ...result, retries }));
}

const toolCallRound = () =>
  assistantMessage({
    content: [
      { type: 'toolCall', id: 'call-1', name: 'eia_route_details', arguments: { route: 'natural-gas' } }
    ],
    stopReason: 'toolUse'
  });

const overloadedRound = () =>
  assistantMessage({
    content: [{ type: 'text', text: '' }],
    stopReason: 'error',
    errorMessage: OVERLOADED
  });

describe('resuming a real Pi agent after a provider failure', () => {
  it('re-runs only the failed round, keeping the tool work that came before it', async () => {
    // The third round reports whether the tool result from round one survived —
    // which is the entire point of continuing rather than re-prompting.
    const { agent, observed } = scriptedAgent([
      toolCallRound,
      overloadedRound,
      (context) =>
        assistantMessage({
          content: [
            {
              type: 'text',
              text: context.messages.some((message) => message.role === 'toolResult')
                ? 'Answered from the earlier tool result.'
                : 'The tool result was lost.'
            }
          ],
          stopReason: 'stop'
        })
    ]);

    const { resumeAttempts, retries } = await resume(agent, observed);

    expect(resumeAttempts).toBe(1);
    expect(retries[0]).toMatchObject({ reason: 'overloaded', attempt: 1, maxAttempts: 3 });
    expect(observed.text).toBe('Answered from the earlier tool result.');
    expect(observed.stopReason).toBe('stop');
    // The failed round leaves nothing behind in the transcript.
    expect(agent.state.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant'
    ]);
  });

  it('stops after the attempt budget and leaves the provider error visible', async () => {
    const { agent, observed } = scriptedAgent([
      toolCallRound,
      overloadedRound,
      overloadedRound,
      overloadedRound,
      overloadedRound
    ]);

    const { resumeAttempts, retries } = await resume(agent, observed);

    expect(resumeAttempts).toBe(3);
    expect(retries.map((event) => event.attempt)).toEqual([1, 2, 3]);
    expect(observed.stopReason).toBe('error');
    expect(observed.errorMessage).toBe(OVERLOADED);
  });

  it('leaves a rejected key alone instead of spending retries on it', async () => {
    const { agent, observed } = scriptedAgent([
      () =>
        assistantMessage({
          content: [{ type: 'text', text: '' }],
          stopReason: 'error',
          errorMessage: '401 Invalid Authentication'
        })
    ]);

    const { resumeAttempts, retries } = await resume(agent, observed);

    expect(resumeAttempts).toBe(0);
    expect(retries).toEqual([]);
  });
});
