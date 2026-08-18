export type BookmarkableChatMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  status?: 'running' | 'completed' | 'error';
  modeStatus?: boolean;
  modelFailure?: unknown;
  credentialRequest?: unknown;
};

export function canBookmarkMessage(message: BookmarkableChatMessage): boolean {
  return (
    message.role === 'assistant' &&
    message.status !== 'running' &&
    message.status !== 'error' &&
    !message.modeStatus &&
    !message.modelFailure &&
    !message.credentialRequest &&
    Boolean(message.text.trim())
  );
}

export function promptForAssistant<T extends BookmarkableChatMessage>(
  messages: T[],
  assistant: T
): string {
  const index = messages.indexOf(assistant);
  if (index < 0) return '';
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const candidate = messages[cursor];
    if (candidate.role === 'user' && candidate.text.trim()) return candidate.text.trim();
  }
  return '';
}

function stableTextHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

export function bookmarkMessageKey(message: Pick<BookmarkableChatMessage, 'timestamp' | 'text'>) {
  return `${Math.max(0, Math.trunc(message.timestamp)).toString(36)}-${stableTextHash(message.text)}`;
}

export function bookmarkPreview(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  const clipped = normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd();
  const wordBoundary = clipped.lastIndexOf(' ');
  const preview = wordBoundary >= Math.floor(maxLength / 2) ? clipped.slice(0, wordBoundary) : clipped;
  return `${preview}…`;
}
