import { describe, expect, it } from 'vitest';
import { telegramPlainText, telegramReplyChunks, telegramStatusLine } from './telegram-channel';

describe('Telegram answer formatting', () => {
  it('removes markdown decoration while preserving link destinations', () => {
    expect(telegramPlainText('## **Answer**\nSee [the source](https://example.com).')).toBe(
      'Answer\nSee the source (https://example.com).'
    );
  });

  it('chunks on readable boundaries without splitting unicode characters', () => {
    const chunks = telegramReplyChunks(`${'fox '.repeat(8)}🦊 tail`, 20);
    expect(chunks.every((chunk) => Array.from(chunk).length <= 20)).toBe(true);
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toContain('🦊 tail');
  });

  it('provides a non-empty fallback reply', () => {
    expect(telegramReplyChunks('   ')).toEqual(['Raynard returned an empty response.']);
  });
});

describe('telegramStatusLine', () => {
  it('names the connected bot and app-running limitation', () => {
    expect(
      telegramStatusLine({
        status: 'connected',
        configured: true,
        enabled: true,
        bot: { id: 1, username: 'raynard_bot', name: 'Raynard' },
        owner: null,
        pairingRequests: [],
        pendingCount: 0
      })
    ).toBe('@raynard_bot is connected while Raynard is running.');
  });
});
