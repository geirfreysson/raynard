import { describe, expect, it } from 'vitest';

import {
  BOOKMARK_TITLE_MAX_LENGTH,
  buildTitlePrompt,
  normalizeBookmarkTitle,
  readTitleFromReply
} from './bookmark-title-core.mjs';

describe('normalizeBookmarkTitle', () => {
  it('keeps a clean title untouched', () => {
    expect(normalizeBookmarkTitle('Apple FY2024 gross margin')).toBe('Apple FY2024 gross margin');
  });

  it('strips the decoration models add despite being told not to', () => {
    expect(normalizeBookmarkTitle('"Apple FY2024 margins"')).toBe('Apple FY2024 margins');
    expect(normalizeBookmarkTitle('**Apple FY2024 margins**')).toBe('Apple FY2024 margins');
    expect(normalizeBookmarkTitle('Title: Apple FY2024 margins')).toBe('Apple FY2024 margins');
    expect(normalizeBookmarkTitle('Apple FY2024 margins.')).toBe('Apple FY2024 margins');
    expect(normalizeBookmarkTitle('“Apple FY2024 margins”')).toBe('Apple FY2024 margins');
  });

  it('unwraps a title that is both quoted and bolded', () => {
    expect(normalizeBookmarkTitle('**"Apple FY2024 margins"**')).toBe('Apple FY2024 margins');
  });

  it('keeps only the first line when the model explains itself', () => {
    expect(normalizeBookmarkTitle('Apple FY2024 margins\n\nThis title captures the answer.')).toBe(
      'Apple FY2024 margins'
    );
  });

  it('collapses whitespace', () => {
    expect(normalizeBookmarkTitle('  Apple   FY2024\tmargins  ')).toBe('Apple FY2024 margins');
  });

  it('truncates an overlong title on a word boundary', () => {
    const long =
      'Comparing quarterly free cash flow across every major semiconductor manufacturer since 2019';
    const title = normalizeBookmarkTitle(long);
    expect(title.length).toBeLessThanOrEqual(BOOKMARK_TITLE_MAX_LENGTH + 1);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/\s…$/);
    // The cut must not land mid-word.
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
  });

  it('reports nothing usable as empty so the caller can fall back', () => {
    expect(normalizeBookmarkTitle('')).toBe('');
    expect(normalizeBookmarkTitle('   ')).toBe('');
    expect(normalizeBookmarkTitle('""')).toBe('');
    expect(normalizeBookmarkTitle(null)).toBe('');
    expect(normalizeBookmarkTitle(undefined)).toBe('');
  });
});

describe('readTitleFromReply', () => {
  it('joins the text blocks and ignores everything else', () => {
    expect(
      readTitleFromReply({
        content: [
          { type: 'thinking', thinking: 'ignore me' },
          { type: 'text', text: 'Apple FY2024 ' },
          { type: 'text', text: 'margins' }
        ]
      })
    ).toBe('Apple FY2024 margins');
  });

  it('survives a reply with no content', () => {
    expect(readTitleFromReply({})).toBe('');
    expect(readTitleFromReply(null)).toBe('');
  });
});

describe('buildTitlePrompt', () => {
  it('sends both the question and the answer', () => {
    const request = buildTitlePrompt({ prompt: 'What are Apple margins?', answer: '46.2% in FY2024.' });
    expect(request.messages).toHaveLength(1);
    expect(request.messages[0].content).toContain('What are Apple margins?');
    expect(request.messages[0].content).toContain('46.2% in FY2024.');
    expect(request.systemPrompt).toContain('at most 8 words');
  });

  it('clips a long answer so one bookmark cannot send a whole transcript', () => {
    const request = buildTitlePrompt({ prompt: 'x'.repeat(4000), answer: 'y'.repeat(9000) });
    expect(request.messages[0].content.length).toBeLessThan(3000);
  });

  it('still produces a usable request when the answer is missing', () => {
    const request = buildTitlePrompt({ prompt: 'What are Apple margins?' });
    expect(request.messages[0].content).toContain('What are Apple margins?');
    expect(request.messages[0].content.trim()).not.toBe('');
  });

  it('falls back to a placeholder when nothing was supplied', () => {
    expect(buildTitlePrompt({}).messages[0].content).toBe('Untitled answer.');
  });
});
