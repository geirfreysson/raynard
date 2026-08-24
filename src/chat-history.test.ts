import { describe, expect, it } from 'vitest';
import { latestChatTurnIso } from './chat-history';

describe('latestChatTurnIso', () => {
  it('uses the newest transcript entry instead of the save time', () => {
    expect(
      latestChatTurnIso(
        [{ timestamp: 1_700_000_000_000 }, { timestamp: 1_710_000_000_000 }],
        '2099-01-01T00:00:00.000Z'
      )
    ).toBe('2024-03-09T16:00:00.000Z');
  });

  it('keeps the existing value when there are no timestamped turns', () => {
    expect(latestChatTurnIso([], '2026-08-24T08:00:00.000Z')).toBe(
      '2026-08-24T08:00:00.000Z'
    );
  });

  it('keeps the existing value for an out-of-range stored timestamp', () => {
    expect(latestChatTurnIso([{ timestamp: Number.MAX_VALUE }], 'safe')).toBe('safe');
  });
});
