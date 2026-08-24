import { describe, expect, it } from 'vitest';
import { filterChatsByName } from './chat-filter';

describe('filterChatsByName', () => {
  const chats = [
    { chatId: 'one', name: 'Release planning' },
    { chatId: 'two', name: 'Iceland itinerary' },
    { chatId: 'three', name: 'Quarterly RELEASE notes' }
  ];

  it('matches chat names case-insensitively', () => {
    expect(filterChatsByName(chats, 'release')).toEqual([chats[0], chats[2]]);
  });

  it('trims the query before filtering', () => {
    expect(filterChatsByName(chats, '  Iceland  ')).toEqual([chats[1]]);
  });

  it('keeps all chats for an empty query', () => {
    expect(filterChatsByName(chats, '   ')).toBe(chats);
  });
});
