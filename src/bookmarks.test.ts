import { describe, expect, it } from 'vitest';
import {
  bookmarkLabel,
  bookmarkMessageKey,
  bookmarkPreview,
  canBookmarkMessage,
  promptForAssistant
} from './bookmarks';

describe('bookmarkLabel', () => {
  it('prefers the model-written title', () => {
    expect(bookmarkLabel({ title: 'Apple FY2024 margins', prompt: 'What are Apple margins?' })).toBe(
      'Apple FY2024 margins'
    );
  });

  it('falls back to the prompt when naming failed or predates titles', () => {
    const prompt = 'What are Apple margins?';
    expect(bookmarkLabel({ title: '', prompt })).toBe(prompt);
    expect(bookmarkLabel({ title: '   ', prompt })).toBe(prompt);
    expect(bookmarkLabel({ prompt })).toBe(prompt);
  });
});

describe('bookmarks', () => {
  it('only offers bookmarks on completed answer messages', () => {
    expect(
      canBookmarkMessage({ role: 'assistant', text: 'Answer', timestamp: 1, status: 'completed' })
    ).toBe(true);
    expect(canBookmarkMessage({ role: 'assistant', text: 'Legacy answer', timestamp: 1 })).toBe(
      true
    );
    expect(
      canBookmarkMessage({ role: 'assistant', text: 'Working', timestamp: 2, status: 'running' })
    ).toBe(false);
    expect(
      canBookmarkMessage({
        role: 'assistant',
        text: 'Mode changed',
        timestamp: 3,
        status: 'completed',
        modeStatus: true
      })
    ).toBe(false);
    expect(
      canBookmarkMessage({ role: 'user', text: 'Question', timestamp: 4, status: 'completed' })
    ).toBe(false);
  });

  it('pairs an answer with the nearest preceding user prompt', () => {
    const answer = {
      role: 'assistant' as const,
      text: 'Second answer',
      timestamp: 4,
      status: 'completed' as const
    };
    const messages = [
      { role: 'user' as const, text: 'First prompt', timestamp: 1 },
      { role: 'assistant' as const, text: 'First answer', timestamp: 2 },
      { role: 'user' as const, text: 'Second prompt', timestamp: 3 },
      answer
    ];

    expect(promptForAssistant(messages, answer)).toBe('Second prompt');
  });

  it('creates stable distinct keys and bounded single-line previews', () => {
    const message = { timestamp: 1234, text: 'A useful answer' };
    expect(bookmarkMessageKey(message)).toBe(bookmarkMessageKey(message));
    expect(bookmarkMessageKey(message)).not.toBe(
      bookmarkMessageKey({ ...message, text: 'A different answer' })
    );
    expect(bookmarkPreview('one\n\n two three', 10)).toBe('one two…');
  });
});
