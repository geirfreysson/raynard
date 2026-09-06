import { describe, expect, it } from 'vitest';
import type { ChartSource } from './chart-sources';
import { stripTelegramReferences, telegramReply, telegramStatusLine } from './telegram-channel';

const url = 'https://financialmodelingprep.com/stable/profile?symbol=ADBE';
const fmpSources: ChartSource[] = [{
  plugin: 'Financial Modeling Prep',
  references: [{ number: 1, label: 'Adobe profile', sourceUrl: url }]
}];

describe('Telegram answer formatting', () => {
  it('renders safe rich text and preserves intentional non-source links', () => {
    expect(telegramReply('## **Answer**\nUse `code` or see [the guide](https://example.com). <script>')).toEqual({
      parseMode: 'HTML',
      chunks: ['<b>Answer</b>\n\nUse <code>code</code> or see <a href="https://example.com">the guide</a>. &lt;script&gt;']
    });
  });

  it('removes source links and citation markers without leaving numeric debris', () => {
    expect(stripTelegramReferences(`Business intact ([1](${url})). [^1]`, fmpSources)).toBe('Business intact.');
    expect(stripTelegramReferences(`According to [Adobe profile](${url}), margins held.`, fmpSources)).toBe('According to Adobe profile, margins held.');
    expect(stripTelegramReferences('[Guide](https://example.com)', fmpSources)).toBe('[Guide](https://example.com)');
  });

  it('turns markdown tables into labelled mobile-friendly records', () => {
    const reply = telegramReply([
      '## Entry strategy', '',
      '| Tranche | Approx. Price | Trigger / Rationale |', '|---|---|---|',
      `| First tranche | ~$266 | Fundamentals are intact ([1](${url})). |`,
      '| Second tranche | ~$235–$240 | Thicker margin of safety. |'
    ].join('\n'), fmpSources);
    const sent = reply.chunks.join('\n');
    expect(sent).toContain('<b>Entry strategy</b>');
    expect(sent).toContain('<b>Tranche:</b> First tranche');
    expect(sent).toContain('<b>Approx. Price:</b> ~$266');
    expect(sent).toContain('Second tranche');
    expect(sent).not.toContain('financialmodelingprep');
    expect(sent).not.toContain('(1)');
  });

  it('chunks on Unicode-safe boundaries and balances formatting tags', () => {
    const reply = telegramReply(`**${'fox 🦊 '.repeat(30)}tail**`, [], 80);
    expect(reply.chunks.length).toBeGreaterThan(1);
    expect(reply.chunks.every((chunk) => Array.from(chunk).length <= 80)).toBe(true);
    expect(reply.chunks.every((chunk) => chunk.startsWith('<b>') && chunk.endsWith('</b>'))).toBe(true);
    expect(reply.chunks.join('')).toContain('🦊');
  });

  it('provides a non-empty fallback reply', () => {
    expect(telegramReply('   ').chunks).toEqual(['Raynard returned an empty response.']);
  });
});

describe('telegramStatusLine', () => {
  it('names the connected bot and app-running limitation', () => {
    expect(telegramStatusLine({
      status: 'connected', configured: true, enabled: true,
      bot: { id: 1, username: 'raynard_bot', name: 'Raynard' }, owner: null,
      pairingRequests: [], pendingCount: 0
    })).toBe('@raynard_bot is connected while Raynard is running.');
  });
});
