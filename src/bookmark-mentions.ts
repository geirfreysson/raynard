// "@" reference support for bookmarks. Rust owns the bookmark collection, the
// slugs, and the matching (`src-tauri/src/bookmark_mentions.rs`), so the
// renderer never holds every bookmark: it turns Rust's candidates into menu
// items, and appends the bookmarks a sent message referenced as delimited
// blocks so the prompt actually carries what it refers to.

import { bookmarkLabel } from './bookmarks';
import type { MentionItem } from './mention';

/** One `@` menu candidate, as `search_bookmark_mentions` returns it. */
export type BookmarkMentionCandidate = {
  slug: string;
  label: string;
  chatName: string;
};

/** A bookmark `resolve_bookmark_mentions` matched in a message. */
export type ReferencedBookmark = {
  id: string;
  title?: string;
  prompt: string;
  answer: string;
};

/** Bookmark reference items for the @-mention menu. */
export function buildBookmarkMentionItems(candidates: BookmarkMentionCandidate[]): MentionItem[] {
  return (Array.isArray(candidates) ? candidates : []).map((candidate) => ({
    kind: 'bookmark',
    match: `${candidate.slug} ${candidate.label}`.toLowerCase(),
    label: candidate.label,
    description: candidate.chatName ? `bookmark · ${candidate.chatName}` : 'bookmark',
    insertText: candidate.slug
  }));
}

/**
 * Appends the full content of each referenced bookmark as a delimited block,
 * so the saved/model-visible text actually carries what was referenced. With
 * nothing referenced the text is returned unchanged.
 */
export function expandBookmarkMentions(text: string, referenced: ReferencedBookmark[]): string {
  const seen = new Set<string>();
  const blocks: string[] = [];
  for (const bookmark of Array.isArray(referenced) ? referenced : []) {
    if (seen.has(bookmark.id)) continue;
    seen.add(bookmark.id);
    const title = bookmarkLabel(bookmark);
    blocks.push(`[Referenced bookmark: ${title}]\nQ: ${bookmark.prompt}\nA: ${bookmark.answer}\n[End referenced bookmark]`);
  }
  if (!blocks.length) return text;
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
