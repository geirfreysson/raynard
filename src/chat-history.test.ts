import { describe, expect, it } from 'vitest';
import { latestChatTurnIso, orderChatsByUpdatedAt, upsertChatByUpdatedAt } from './chat-history';

describe('chat history ordering', () => {
  const older = { chatId: 'older', updatedAt: '2026-08-30T10:00:00.000Z' };
  const newer = { chatId: 'newer', updatedAt: '2026-08-31T10:00:00.000Z' };

  it('orders chats by their most recent update', () => {
    expect(orderChatsByUpdatedAt([older, newer]).map((chat) => chat.chatId)).toEqual([
      'newer',
      'older'
    ]);
  });

  it('moves a newly saved chat to the front while replacing its stale row', () => {
    const updated = { ...older, updatedAt: '2026-09-01T10:00:00.000Z' };
    expect(upsertChatByUpdatedAt([older, newer], updated)).toEqual([updated, newer]);
  });

  it('keeps malformed legacy dates after dated chats', () => {
    const legacy = { chatId: 'legacy', updatedAt: 'unknown' };
    expect(orderChatsByUpdatedAt([legacy, newer])).toEqual([newer, legacy]);
  });
});

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
