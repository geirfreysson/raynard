// "@" reference support for bookmarks: build mention candidates from saved
// bookmarks, and expand a bookmark mention token into the bookmark's full
// saved content so a later prompt actually carries what it references.

import { bookmarkLabel, stableTextHash } from './bookmarks';
import { isReferenceTokenChar, type MentionItem } from './mention';

export type MentionableBookmark = {
  id: string;
  title?: string;
  prompt: string;
  answer: string;
  chatName?: string;
};

function kebabCase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/g, '');
}

/** A stable, unique @-mention slug for a bookmark: kebab(title) + a short hash of its id. */
export function bookmarkMentionSlug(bookmark: MentionableBookmark): string {
  const base = kebabCase(bookmarkLabel(bookmark)) || 'bookmark';
  const suffix = stableTextHash(bookmark.id).slice(0, 6);
  return `${base}-${suffix}`;
}

/** Bookmark reference items for the @-mention menu. */
export function buildBookmarkMentionItems(bookmarks: MentionableBookmark[]): MentionItem[] {
  return (Array.isArray(bookmarks) ? bookmarks : []).map((bookmark) => {
    const label = bookmarkLabel(bookmark);
    const slug = bookmarkMentionSlug(bookmark);
    return {
      kind: 'bookmark',
      match: `${slug} ${label}`.toLowerCase(),
      label,
      description: bookmark.chatName ? `bookmark · ${bookmark.chatName}` : 'bookmark',
      insertText: slug
    };
  });
}

/** Slug -> bookmark, for resolving a mention token back to its content. */
export function buildBookmarkMentionIndex(
  bookmarks: MentionableBookmark[]
): Map<string, MentionableBookmark> {
  const index = new Map<string, MentionableBookmark>();
  for (const bookmark of Array.isArray(bookmarks) ? bookmarks : []) {
    index.set(bookmarkMentionSlug(bookmark), bookmark);
  }
  return index;
}

/** Every `@token` span in `text`, using the same rules as the mention menu's own detector. */
function findAtTokens(text: string): Array<{ token: string; start: number; end: number }> {
  const tokens: Array<{ token: string; start: number; end: number }> = [];
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] !== '@') continue;
    const previousChar = index > 0 ? text[index - 1] : '';
    if (previousChar && isReferenceTokenChar(previousChar)) continue;
    let end = index + 1;
    while (end < text.length && isReferenceTokenChar(text[end])) end += 1;
    if (end === index + 1) continue; // bare "@" with nothing after
    tokens.push({ token: text.slice(index + 1, end), start: index, end });
    index = end - 1;
  }
  return tokens;
}

/**
 * Appends the full content of every bookmark mentioned in `text` as a
 * delimited block, so the saved/model-visible text actually carries what was
 * referenced. Text with no recognized bookmark mention is returned unchanged.
 */
export function expandBookmarkMentions(text: string, index: Map<string, MentionableBookmark>): string {
  const seen = new Set<string>();
  const matched: MentionableBookmark[] = [];
  for (const { token } of findAtTokens(text)) {
    const bookmark = index.get(token);
    if (bookmark && !seen.has(bookmark.id)) {
      seen.add(bookmark.id);
      matched.push(bookmark);
    }
  }
  if (!matched.length) return text;

  const blocks = matched.map((bookmark) => {
    const title = bookmarkLabel(bookmark);
    return `[Referenced bookmark: ${title}]\nQ: ${bookmark.prompt}\nA: ${bookmark.answer}\n[End referenced bookmark]`;
  });
  return `${text}\n\n${blocks.join('\n\n')}`;
}

export type BookmarkReferenceBlock = {
  start: number;
  end: number;
  title: string;
  prompt: string;
  answer: string;
};

/**
 * Finds every `[Referenced bookmark: ...]...[End referenced bookmark]` block
 * `expandBookmarkMentions` appended, so a renderer can collapse each one into
 * a clickable marker without re-showing the full quoted text inline.
 */
export function parseBookmarkReferenceBlocks(text: string): BookmarkReferenceBlock[] {
  const pattern =
    /\[Referenced bookmark: ([^\]]+)\]\nQ: ([\s\S]*?)\nA: ([\s\S]*?)\n\[End referenced bookmark\]/g;
  const blocks: BookmarkReferenceBlock[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    const [full, title, prompt, answer] = match;
    blocks.push({ start: match.index, end: match.index + full.length, title, prompt, answer });
  }
  return blocks;
}
