import { describe, expect, it } from 'vitest';
import { describeModelFailure } from './model-error';

const moonshot = { provider: 'moonshot', model: 'kimi-k2.5', role: 'chat' as const };

describe('describeModelFailure', () => {
  it('names the provider that gave up, not the app or the plugin', () => {
    // The exact failure that ended a turn after 13 successful EIA tool calls.
    const failure = describeModelFailure(
      '429 The engine is currently overloaded, please try again later (stopReason: error)',
      { ...moonshot, resumeAttempts: 3 }
    );

    expect(failure.title).toBe('Moonshot is still overloaded');
    expect(failure.detail).toContain('Retried 3 times');
    expect(failure.detail).toContain('installed plugins');
    expect(failure.retryable).toBe(true);
    expect(failure.raw).toContain('429 The engine is currently overloaded');
  });

  it('does not claim a retry that never happened', () => {
    const failure = describeModelFailure('503 Service Unavailable', {
      ...moonshot,
      resumeAttempts: 0
    });

    expect(failure.detail).not.toContain('Retried');
    expect(failure.title).toBe('Moonshot could not be reached');
  });

  it('sends a rejected key to the place that fixes it, and does not call it retryable', () => {
    const failure = describeModelFailure('401 Invalid Authentication', moonshot);

    expect(failure.title).toBe('Moonshot rejected the API key');
    expect(failure.detail).toContain('/models');
    expect(failure.retryable).toBe(false);
  });

  it('explains an exhausted context as something the user can act on', () => {
    const failure = describeModelFailure(
      "400 This model's maximum context length is 262144 tokens",
      moonshot
    );

    expect(failure.title).toContain('kimi-k2.5');
    expect(failure.detail).toContain('Narrow the query');
    expect(failure.retryable).toBe(false);
  });

  it('attributes an unrecognised failure to the model without inventing a cause', () => {
    const failure = describeModelFailure('Something unusual happened', moonshot);

    expect(failure.title).toBe('Moonshot (kimi-k2.5) stopped this turn');
    expect(failure.detail).toContain('Something unusual happened');
  });

  it('speaks about the coding model on the builder path', () => {
    const failure = describeModelFailure('429 overloaded', {
      provider: 'moonshot',
      model: 'kimi-k3',
      role: 'builder',
      resumeAttempts: 3
    });

    expect(failure.detail).toContain('coding');
    expect(failure.detail).not.toContain('installed plugins');
  });

  it('falls back to a generic name when the provider is unknown', () => {
    expect(describeModelFailure('429 overloaded', { role: 'chat' }).title).toBe(
      'The model provider is overloaded'
    );
    expect(describeModelFailure('boom', { provider: 'claude', role: 'chat' }).title).toBe(
      'Claude stopped this turn'
    );
  });

  it('never blames the provider for a plugin failure', () => {
    const failure = describeModelFailure('Tool failed: eia_series_search', moonshot);

    expect(failure.title).toBe('Moonshot (kimi-k2.5) stopped this turn');
    expect(failure.retryable).toBe(false);
  });

  it('survives an empty error rather than rendering a blank notice', () => {
    const failure = describeModelFailure('', moonshot);

    expect(failure.title).toBe('Moonshot (kimi-k2.5) stopped this turn');
    expect(failure.detail.length).toBeGreaterThan(0);
  });
});
