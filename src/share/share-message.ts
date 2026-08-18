import { canBookmarkMessage, type BookmarkableChatMessage } from '../bookmarks';

export type ShareableChatMessage = BookmarkableChatMessage & { builderRun?: boolean };

/**
 * Which messages get a Share button.
 *
 * Reuses the bookmark rules rather than restating them — a message that is still
 * running, errored, a mode-status line, a model failure, a credential request, or
 * empty is not an answer. Builder runs are excluded on top of that: a
 * plugin-writing transcript satisfies those rules but has no answer to share.
 */
export function canShareMessage(message: ShareableChatMessage): boolean {
  return canBookmarkMessage(message) && !message.builderRun;
}
