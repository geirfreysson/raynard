import { describe, expect, it } from 'vitest';
import {
  DEFAULT_COMPACTION_SETTINGS,
  applyCompaction,
  createContextCompactor,
  collectFileOperations,
  estimateContextTokens,
  findCutIndex,
  formatFileOperations,
  shouldCompact
} from './builder-compaction.mjs';

function user(text) {
  return { role: 'user', content: text };
}

function assistant(text, toolCalls = []) {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text },
      ...toolCalls.map((call) => ({ type: 'toolCall', id: call.id, name: call.name, arguments: call.args }))
    ],
    usage: { totalTokens: 0 }
  };
}

function toolResult(id, name, text) {
  return { role: 'toolResult', toolCallId: id, toolName: name, content: [{ type: 'text', text }], isError: false };
}

describe('builder compaction', () => {
  it('compacts only once the context nears the window', () => {
    const settings = DEFAULT_COMPACTION_SETTINGS;
    expect(shouldCompact(100_000, 262_144, settings)).toBe(false);
    expect(shouldCompact(250_000, 262_144, settings)).toBe(true);
    // Exactly at the reserve boundary is still safe.
    expect(shouldCompact(262_144 - settings.reserveTokens, 262_144, settings)).toBe(false);
    expect(shouldCompact(999_999, 262_144, { ...settings, enabled: false })).toBe(false);
  });

  it('prefers reported usage over an estimate', () => {
    const withUsage = [user('hi'), { ...assistant('there'), usage: { totalTokens: 4321 } }];
    expect(estimateContextTokens(withUsage)).toBe(4321);
    // No usage reported: fall back to a size estimate rather than assuming zero.
    const withoutUsage = [user('x'.repeat(4000))];
    expect(estimateContextTokens(withoutUsage)).toBeGreaterThan(500);
  });

  it('never cuts between a tool call and its result', () => {
    const messages = [
      user('build it'),
      assistant('reading', [{ id: 'c1', name: 'read', args: { path: 'a.ts' } }]),
      toolResult('c1', 'read', 'contents'),
      user('carry on'),
      assistant('done')
    ];
    // Whatever the budget, the cut must not land on a toolResult.
    for (let keep = 0; keep < 4000; keep += 137) {
      const cut = findCutIndex(messages, keep);
      expect(messages[cut]?.role).not.toBe('toolResult');
    }
  });

  it('keeps the most recent turns and drops the oldest', () => {
    const messages = [
      user('a'.repeat(8000)),
      assistant('b'.repeat(8000)),
      user('recent question'),
      assistant('recent answer')
    ];
    const cut = findCutIndex(messages, 100);
    expect(cut).toBeGreaterThan(0);
    expect(messages.slice(cut).map((m) => m.role)).toContain('assistant');
  });

  it('carries which files were read and which were changed', () => {
    const messages = [
      assistant('', [
        { id: 'c1', name: 'read', args: { path: '/p/client.ts' } },
        { id: 'c2', name: 'write', args: { path: '/p/tools.ts' } }
      ]),
      toolResult('c1', 'read', 'ok'),
      toolResult('c2', 'write', 'ok'),
      assistant('', [{ id: 'c3', name: 'edit', args: { path: '/p/tools.ts' } }]),
      toolResult('c3', 'edit', 'ok')
    ];

    const ops = collectFileOperations(messages);
    expect([...ops.read]).toEqual(['/p/client.ts']);
    expect([...ops.modified].sort()).toEqual(['/p/tools.ts']);

    const formatted = formatFileOperations(ops);
    expect(formatted).toContain('/p/client.ts');
    expect(formatted).toContain('/p/tools.ts');
  });

  it('replaces the dropped prefix with a summary the model can act on', () => {
    const messages = [
      user('build the weather plugin'),
      assistant('wrote client.ts', [{ id: 'c1', name: 'write', args: { path: '/p/client.ts' } }]),
      toolResult('c1', 'write', 'ok'),
      user('keep going'),
      assistant('still going')
    ];

    const compacted = applyCompaction({
      messages,
      cutIndex: 3,
      summary: 'client.ts is written and its tests pass; tools.ts is still the stub.',
      fileOps: collectFileOperations(messages)
    });

    expect(compacted.length).toBe(3);
    expect(compacted[0].role).toBe('user');
    expect(compacted[0].content).toContain('tools.ts is still the stub');
    expect(compacted[0].content).toContain('/p/client.ts');
    // The recent turns survive untouched.
    expect(compacted.slice(1)).toEqual(messages.slice(3));
  });

  it('leaves the transcript alone when there is nothing worth dropping', () => {
    const messages = [user('hi'), assistant('hello')];
    expect(applyCompaction({ messages, cutIndex: 0, summary: 'x' })).toBe(messages);
  });

  describe('compactor', () => {
    const contextWindow = 40_000;
    const big = () => 'x'.repeat(40_000); // ~10k tokens each

    it('summarizes once and reuses it as the transcript grows', async () => {
      let calls = 0;
      const compact = createContextCompactor({
        contextWindow,
        summarize: async () => {
          calls += 1;
          return `summary ${calls}`;
        }
      });

      const messages = [user(big()), assistant(big()), user(big()), assistant('recent')];
      const first = await compact(messages);
      expect(calls).toBe(1);
      expect(first[0].content).toContain('summary 1');

      // Pi does not write the transform back, so the next call arrives with the
      // same prefix plus whatever was appended. That must not re-summarize.
      const second = await compact([...messages, assistant('newer')]);
      expect(calls).toBe(1);
      expect(second[0].content).toContain('summary 1');
      expect(second.at(-1).content[0].text).toBe('newer');
    });

    it('does nothing until the context nears the window', async () => {
      let calls = 0;
      const compact = createContextCompactor({
        contextWindow: 262_144,
        summarize: async () => {
          calls += 1;
          return 'summary';
        }
      });

      const messages = [user('short'), assistant('also short')];
      expect(await compact(messages)).toBe(messages);
      expect(calls).toBe(0);
    });

    it('keeps the transcript when summarizing fails', async () => {
      // Compaction is a safeguard. A summarizer that throws must not take the
      // build turn down with it.
      const statuses = [];
      const messages = [user(big()), assistant(big()), user(big()), assistant('recent')];

      const throwing = createContextCompactor({
        contextWindow,
        summarize: async () => {
          throw new Error('provider down');
        },
        onStatus: (status) => statuses.push(status)
      });
      expect(await throwing(messages)).toBe(messages);
      expect(statuses.some((status) => status.includes('provider down'))).toBe(true);

      const quiet = createContextCompactor({ contextWindow, summarize: async () => '' });
      expect(await quiet(messages)).toBe(messages);
    });
  });
});
