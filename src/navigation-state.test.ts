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

  it('blocks switching to another saved chat during the active stream', () => {
    expect(
      decideChatNavigation({
        targetChatId: 'chat-old',
        activeChatId: 'chat-live',
        isRunning: true
      })
    ).toBe('block');
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
