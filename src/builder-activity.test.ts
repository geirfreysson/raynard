import { describe, expect, it } from 'vitest';
import {
  applyBuilderToolEvent,
  formatBuilderToolOutput,
  planBuilderTimeline,
  type BuilderToolActivity
} from './builder-activity';

describe('applyBuilderToolEvent', () => {
  it('tracks a tool execution by its stable Pi tool call id', () => {
    const started = applyBuilderToolEvent([], {
      type: 'start',
      toolCallId: 'call-1',
      toolName: 'write',
      args: { path: 'src/index.ts', content: 'export const value = 1;' }
    });

    expect(started).toEqual([
      {
        toolCallId: 'call-1',
        toolName: 'write',
        args: { path: 'src/index.ts', content: 'export const value = 1;' },
        status: 'pending',
        output: '',
        isError: false
      }
    ]);
  });

  it('updates the existing execution instead of adding duplicate cards', () => {
    const initial: BuilderToolActivity[] = [
      {
        toolCallId: 'call-1',
        toolName: 'bash',
        args: { command: 'node --test' },
        status: 'pending',
        output: '',
        isError: false
      }
    ];

    const streaming = applyBuilderToolEvent(initial, {
      type: 'update',
      toolCallId: 'call-1',
      toolName: 'bash',
      args: { command: 'node --test' },
      partialResult: { content: [{ type: 'text', text: 'TAP version 13' }] }
    });
    const completed = applyBuilderToolEvent(streaming, {
      type: 'end',
      toolCallId: 'call-1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: '1..2\n# pass 2' }] },
      isError: false
    });

    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      toolCallId: 'call-1',
      status: 'complete',
      output: '1..2\n# pass 2',
      isError: false
    });
    expect(initial[0].status).toBe('pending');
  });

  it('keeps failed tool executions marked as errors', () => {
    const activities = applyBuilderToolEvent([], {
      type: 'end',
      toolCallId: 'call-2',
      toolName: 'edit',
      result: { content: [{ type: 'text', text: 'File not found' }] },
      isError: true
    });

    expect(activities[0]).toMatchObject({
      status: 'error',
      output: 'File not found',
      isError: true
    });
  });
});

describe('planBuilderTimeline', () => {
  const ids = (list: string[]) => list.map((toolCallId) => ({ toolCallId }));

  it('reuses existing cards in place instead of rebuilding them', () => {
    const { ops, length } = planBuilderTimeline(['a', 'b'], ids(['a', 'b']));
    expect(length).toBe(2);
    expect(ops).toEqual([
      { action: 'reuse', index: 0, toolCallId: 'a' },
      { action: 'reuse', index: 1, toolCallId: 'b' }
    ]);
  });

  it('only inserts the newly appended card and reuses the rest', () => {
    const { ops } = planBuilderTimeline(['a', 'b'], ids(['a', 'b', 'c']));
    expect(ops).toEqual([
      { action: 'reuse', index: 0, toolCallId: 'a' },
      { action: 'reuse', index: 1, toolCallId: 'b' },
      { action: 'insert', index: 2, toolCallId: 'c' }
    ]);
  });

  it('inserts every card when nothing is rendered yet', () => {
    const { ops } = planBuilderTimeline([], ids(['a', 'b']));
    expect(ops.map((op) => op.action)).toEqual(['insert', 'insert']);
  });

  it('signals trimming when there are more rendered cards than activities', () => {
    const { ops, length } = planBuilderTimeline(['a', 'b', 'c'], ids(['a']));
    expect(ops).toEqual([{ action: 'reuse', index: 0, toolCallId: 'a' }]);
    expect(length).toBe(1);
  });
});

describe('formatBuilderToolOutput', () => {
  it('joins Pi text result blocks and preserves structured fallback data', () => {
    expect(
      formatBuilderToolOutput({
        content: [
          { type: 'text', text: 'first' },
          { type: 'text', text: 'second' }
        ]
      })
    ).toBe('first\nsecond');
    expect(formatBuilderToolOutput({ changed: true })).toBe('{\n  "changed": true\n}');
  });
});
