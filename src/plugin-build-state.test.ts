import { describe, expect, it } from 'vitest';
import { recoverInterruptedMessages, shouldUsePluginEditMode } from './plugin-build-state';

describe('plugin build state', () => {
  it('resumes an empty scaffold through the validated fresh-build path', () => {
    expect(
      shouldUsePluginEditMode({ exists: true, hasRuntimeTools: false, status: 'scaffolded' })
    ).toBe(false);
  });

  it('uses interactive edit mode for a plugin with discovered runtime tools', () => {
    expect(
      shouldUsePluginEditMode({ exists: true, hasRuntimeTools: true, status: 'scaffolded' })
    ).toBe(true);
  });

  it('does not use edit mode when the plugin does not exist', () => {
    expect(
      shouldUsePluginEditMode({ exists: false, hasRuntimeTools: false, status: '' })
    ).toBe(false);
  });

  it('marks persisted running messages as interrupted when no live run owns them', () => {
    const result = recoverInterruptedMessages([
      { role: 'user' as const, text: 'build it', status: undefined },
      { role: 'assistant' as const, text: 'Working...', status: 'running' as const }
    ]);

    expect(result.recovered).toBe(true);
    expect(result.messages[1]).toMatchObject({
      status: 'error',
      error: 'This run was interrupted before it completed.'
    });
  });

  it('keeps what the interrupted run produced, since the next turn is built from it', () => {
    const answer = 'Iceland was above all three peers by 2023.\n\n```chart\n{"type":"line"}\n```';
    const result = recoverInterruptedMessages([
      { role: 'assistant' as const, text: answer, status: 'running' as const }
    ]);

    expect(result.messages[0].text).toBe(answer);
    expect(result.messages[0].status).toBe('error');
  });

  it('falls back to the notice when the run produced nothing', () => {
    const result = recoverInterruptedMessages([
      { role: 'assistant' as const, text: '   ', status: 'running' as const }
    ]);

    expect(result.messages[0].text).toBe('This run was interrupted before it completed.');
  });

  it('leaves settled messages alone', () => {
    const messages = [
      { role: 'assistant' as const, text: 'Done.', status: 'completed' as const },
      { role: 'assistant' as const, text: 'Failed.', status: 'error' as const }
    ];
    const result = recoverInterruptedMessages(messages);

    expect(result.recovered).toBe(false);
    expect(result.messages).toEqual(messages);
  });
});
