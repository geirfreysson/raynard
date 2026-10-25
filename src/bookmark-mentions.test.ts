import { describe, expect, it } from 'vitest';
import {
  buildBookmarkMentionItems,
  expandBookmarkMentions,
  parseBookmarkReferenceBlocks,
  type ReferencedBookmark
} from './bookmark-mentions';

// Slug generation and matching live in Rust (`src-tauri/src/bookmark_mentions.rs`)
// and are tested there; these cover the renderer's half.

const appleBookmark: ReferencedBookmark = {
  id: 'apple-1',
  title: 'Apple FY2024 margins',
  prompt: 'What are Apple FY2024 margins?',
  answer: 'Gross margin was 46.2%.'
};

const secondAppleBookmark: ReferencedBookmark = {
  id: 'apple-2',
  title: 'Apple FY2024 margins',
  prompt: 'What are Apple FY2024 margins, again?',
  answer: 'Still 46.2%.'
};

describe('buildBookmarkMentionItems', () => {
  it('produces bookmark-kind items with slug insertText and title label', () => {
    const items = buildBookmarkMentionItems([
      { slug: 'apple-fy2024-margins-176azl', label: 'Apple FY2024 margins', chatName: 'Q3 research' }
    ]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe('bookmark');
    expect(items[0].label).toBe('Apple FY2024 margins');
    expect(items[0].insertText).toBe('apple-fy2024-margins-176azl');
    expect(items[0].match).toBe('apple-fy2024-margins-176azl apple fy2024 margins');
    expect(items[0].description).toContain('Q3 research');
  });

  it('describes a candidate without a chat name as a plain bookmark', () => {
    const items = buildBookmarkMentionItems([{ slug: 'x-abc123', label: 'X', chatName: '' }]);
    expect(items[0].description).toBe('bookmark');
  });
});

describe('expandBookmarkMentions', () => {
  it('leaves text unchanged when nothing was referenced', () => {
    expect(expandBookmarkMentions('just a plain message', [])).toBe('just a plain message');
  });

  it('appends the full bookmark content after the untouched message', () => {
    const text = 'if you look at apple-fy2024-margins-176azl, is it still true?';
    const expanded = expandBookmarkMentions(text, [appleBookmark]);
    expect(expanded.startsWith(text)).toBe(true);
    expect(expanded).toContain('[Referenced bookmark: Apple FY2024 margins]');
    expect(expanded).toContain('Q: What are Apple FY2024 margins?');
    expect(expanded).toContain('A: Gross margin was 46.2%.');
    expect(expanded).toContain('[End referenced bookmark]');
  });

  it('labels an untitled bookmark by its prompt', () => {
    const expanded = expandBookmarkMentions('see', [{ ...appleBookmark, title: '' }]);
    expect(expanded).toContain('[Referenced bookmark: What are Apple FY2024 margins?]');
  });

  it('appends one block per distinct bookmark', () => {
    const expanded = expandBookmarkMentions('compare', [appleBookmark, secondAppleBookmark, appleBookmark]);
    expect((expanded.match(/\[Referenced bookmark:/g) || []).length).toBe(2);
  });
});

describe('parseBookmarkReferenceBlocks', () => {
  it('finds no blocks in plain text', () => {
    expect(parseBookmarkReferenceBlocks('nothing to see here')).toEqual([]);
  });

  it('extracts title, prompt, and answer for a single expanded mention', () => {
    const expanded = expandBookmarkMentions('look at apple-fy2024-margins-176azl', [appleBookmark]);
    const blocks = parseBookmarkReferenceBlocks(expanded);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].title).toBe('Apple FY2024 margins');
    expect(blocks[0].prompt).toBe('What are Apple FY2024 margins?');
    expect(blocks[0].answer).toBe('Gross margin was 46.2%.');
    expect(expanded.slice(blocks[0].start, blocks[0].end)).toContain('[Referenced bookmark:');
  });

  it('extracts one block per mention for multiple bookmarks', () => {
    const blocks = parseBookmarkReferenceBlocks(
      expandBookmarkMentions('compare these', [appleBookmark, secondAppleBookmark])
    );
    expect(blocks).toHaveLength(2);
    expect(blocks[0].end).toBeLessThanOrEqual(blocks[1].start);
  });
});
