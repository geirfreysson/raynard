import { describe, expect, it } from 'vitest';
import { agentActivityLabel } from './agent-activity';

describe('agentActivityLabel', () => {
  it('shows a generic label while the turn waits with nothing on screen', () => {
    expect(agentActivityLabel({ running: true, streaming: false })).toBe('Working…');
  });

  it('names the tool being called', () => {
    expect(agentActivityLabel({ running: true, streaming: false, toolName: 'data360_get_data' })).toBe(
      'Calling data360_get_data…'
    );
  });

  it('keeps showing a tool call even once text has streamed', () => {
    // The agent can answer partly, then go back out to an API; that second wait
    // still needs an indicator.
    expect(agentActivityLabel({ running: true, streaming: true, toolName: 'dnd_get_monster' })).toBe(
      'Calling dnd_get_monster…'
    );
  });

  it('hides once text is arriving, which is its own proof of life', () => {
    expect(agentActivityLabel({ running: true, streaming: true })).toBeNull();
  });

  it('hides as soon as the turn is no longer running', () => {
    expect(agentActivityLabel({ running: false, streaming: false })).toBeNull();
    expect(agentActivityLabel({ running: false, streaming: true, toolName: 'x' })).toBeNull();
  });

  it('ignores a blank tool name rather than rendering "Calling …"', () => {
    expect(agentActivityLabel({ running: true, streaming: false, toolName: '   ' })).toBe('Working…');
  });

  it('says the model is overloaded while a retry waits out the backoff', () => {
    expect(
      agentActivityLabel({
        running: true,
        streaming: false,
        retry: { reason: 'overloaded', attempt: 1, maxAttempts: 3 }
      })
    ).toBe('The model is overloaded — retrying (1/3)…');
  });

  it('ranks a pending retry above the tool call and the streamed text it interrupted', () => {
    // Both were true when the provider failed; neither describes what the turn
    // is actually doing now, which is waiting.
    expect(
      agentActivityLabel({
        running: true,
        streaming: true,
        toolName: 'eia_series_data',
        retry: { reason: 'rate_limited', attempt: 2, maxAttempts: 3 }
      })
    ).toBe('The model provider is rate limiting us — retrying (2/3)…');
  });

  it('still names an unfamiliar retry reason rather than showing a raw slug', () => {
    expect(
      agentActivityLabel({
        running: true,
        streaming: false,
        retry: { reason: 'something_new', attempt: 1, maxAttempts: 3 }
      })
    ).toBe('The model stopped — retrying (1/3)…');
  });
});
