import { describe, expect, it } from 'vitest';
import { decideChatNavigation } from './navigation-state';

describe('chat navigation while an agent is running', () => {
  it('returns directly to the active live conversation', () => {
    expect(
      decideChatNavigation({
        targetChatId: 'chat-live',
        activeChatId: 'chat-live',
        isRunning: true
      })
    ).toBe('show-active');
  });

  it('still loads another saved chat while a turn is running (background run persists to its own chat)', () => {
    expect(
      decideChatNavigation({
        targetChatId: 'chat-old',
        activeChatId: 'chat-live',
        isRunning: true
      })
    ).toBe('load');
  });

  it('loads another saved chat after the stream has finished', () => {
    expect(
      decideChatNavigation({
        targetChatId: 'chat-old',
        activeChatId: 'chat-live',
        isRunning: false
      })
    ).toBe('load');
  });
});
