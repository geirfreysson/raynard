import { describe, expect, it } from 'vitest';
import {
  bookmarkMentionSlug,
  buildBookmarkMentionIndex,
  buildBookmarkMentionItems,
  expandBookmarkMentions,
  parseBookmarkReferenceBlocks,
  type MentionableBookmark
} from './bookmark-mentions';

const appleBookmark: MentionableBookmark = {
  id: 'apple-1',
  title: 'Apple FY2024 margins',
  prompt: 'What are Apple FY2024 margins?',
  answer: 'Gross margin was 46.2%.',
  chatName: 'Q3 research'
};

const secondAppleBookmark: MentionableBookmark = {
  id: 'apple-2',
  title: 'Apple FY2024 margins',
  prompt: 'What are Apple FY2024 margins, again?',
  answer: 'Still 46.2%.'
};

describe('bookmarkMentionSlug', () => {
  it('is unique across two bookmarks that share a title', () => {
    const first = bookmarkMentionSlug(appleBookmark);
    const second = bookmarkMentionSlug(secondAppleBookmark);
    expect(first).not.toBe(second);
    expect(first.startsWith('apple-fy2024-margins-')).toBe(true);
    expect(second.startsWith('apple-fy2024-margins-')).toBe(true);
  });

  it('is stable for the same bookmark', () => {
    expect(bookmarkMentionSlug(appleBookmark)).toBe(bookmarkMentionSlug({ ...appleBookmark }));
  });
});

describe('buildBookmarkMentionItems', () => {
  it('produces bookmark-kind items with slug insertText and title label', () => {
    const items = buildBookmarkMentionItems([appleBookmark]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('bookmark');
    expect(items[0].label).toBe('Apple FY2024 margins');
    expect(items[0].insertText).toBe(bookmarkMentionSlug(appleBookmark));
    expect(items[0].description).toContain('Q3 research');
  });
});

describe('expandBookmarkMentions', () => {
  it('leaves text with no mention unchanged', () => {
    const index = buildBookmarkMentionIndex([appleBookmark]);
    const text = 'just a plain message';
    expect(expandBookmarkMentions(text, index)).toBe(text);
  });

  it('leaves an unmatched @token untouched and does not throw', () => {
    const index = buildBookmarkMentionIndex([appleBookmark]);
    const text = 'look at @not-a-real-bookmark please';
    expect(expandBookmarkMentions(text, index)).toBe(text);
  });

  it('appends the full bookmark content for a single mention', () => {
    const index = buildBookmarkMentionIndex([appleBookmark]);
    const slug = bookmarkMentionSlug(appleBookmark);
    const text = `look at @${slug} and tell me whether it is still true`;
    const expanded = expandBookmarkMentions(text, index);
    expect(expanded.startsWith(text)).toBe(true);
    expect(expanded).toContain('[Referenced bookmark: Apple FY2024 margins]');
    expect(expanded).toContain('Q: What are Apple FY2024 margins?');
    expect(expanded).toContain('A: Gross margin was 46.2%.');
    expect(expanded).toContain('[End referenced bookmark]');
  });

  it('appends one block per distinct mention when multiple bookmarks are referenced', () => {
    const index = buildBookmarkMentionIndex([appleBookmark, secondAppleBookmark]);
    const text = `compare @${bookmarkMentionSlug(appleBookmark)} with @${bookmarkMentionSlug(secondAppleBookmark)}`;
    const expanded = expandBookmarkMentions(text, index);
    expect((expanded.match(/\[Referenced bookmark:/g) || []).length).toBe(2);
  });

  it('leaves the sentence intact and appends the block after it', () => {
    const index = buildBookmarkMentionIndex([appleBookmark]);
    const slug = bookmarkMentionSlug(appleBookmark);
    const text = `@${slug} is that still true?`;
    const expanded = expandBookmarkMentions(text, index);
    expect(expanded.startsWith(text)).toBe(true);
  });
});

describe('parseBookmarkReferenceBlocks', () => {
  it('finds no blocks in plain text', () => {
    expect(parseBookmarkReferenceBlocks('nothing to see here')).toEqual([]);
  });

  it('extracts title, prompt, and answer for a single expanded mention', () => {
    const index = buildBookmarkMentionIndex([appleBookmark]);
    const slug = bookmarkMentionSlug(appleBookmark);
    const expanded = expandBookmarkMentions(`look at @${slug}`, index);
    const blocks = parseBookmarkReferenceBlocks(expanded);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('Apple FY2024 margins');
    expect(blocks[0].prompt).toBe('What are Apple FY2024 margins?');
    expect(blocks[0].answer).toBe('Gross margin was 46.2%.');
    expect(expanded.slice(blocks[0].start, blocks[0].end)).toContain('[Referenced bookmark:');
  });

  it('extracts one block per mention for multiple bookmarks', () => {
    const index = buildBookmarkMentionIndex([appleBookmark, secondAppleBookmark]);
    const text = `compare @${bookmarkMentionSlug(appleBookmark)} with @${bookmarkMentionSlug(secondAppleBookmark)}`;
    const blocks = parseBookmarkReferenceBlocks(expandBookmarkMentions(text, index));
    expect(blocks).toHaveLength(2);
    expect(blocks[0].end).toBeLessThanOrEqual(blocks[1].start);
  });
});
