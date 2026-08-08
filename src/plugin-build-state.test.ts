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
      text: 'This run was interrupted before it completed.',
      error: 'This run was interrupted before it completed.'
    });
  });
});
