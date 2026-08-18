import { describe, expect, it } from 'vitest';

import { canShareMessage, type ShareableChatMessage } from './share-message';

function message(overrides: Partial<ShareableChatMessage> = {}): ShareableChatMessage {
  return { role: 'assistant', text: 'An answer.', timestamp: 1, status: 'completed', ...overrides };
}

describe('canShareMessage', () => {
  it('allows a completed assistant answer', () => {
    expect(canShareMessage(message())).toBe(true);
  });

  it('refuses anything that is not a finished answer', () => {
    expect(canShareMessage(message({ role: 'user' }))).toBe(false);
    expect(canShareMessage(message({ status: 'running' }))).toBe(false);
    expect(canShareMessage(message({ status: 'error' }))).toBe(false);
    expect(canShareMessage(message({ modeStatus: true }))).toBe(false);
    expect(canShareMessage(message({ modelFailure: { title: 'x' } }))).toBe(false);
    expect(canShareMessage(message({ credentialRequest: { plugin: 'x' } }))).toBe(false);
    expect(canShareMessage(message({ text: '   ' }))).toBe(false);
  });

  it('refuses a builder run, which is a plugin transcript rather than an answer', () => {
    expect(canShareMessage(message({ builderRun: true }))).toBe(false);
  });
});
