export type TelegramChannelStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaitingPairing'
  | 'connected'
  | 'error';

export type TelegramBotIdentity = {
  id: number;
  username: string;
  name: string;
};

export type TelegramOwner = {
  userId: number;
  username?: string | null;
  name: string;
  approvedAt: number;
};

export type TelegramPairingRequest = {
  id: string;
  userId: number;
  chatId: number;
  username?: string | null;
  name: string;
  createdAt: number;
  expiresAt: number;
};

export type TelegramChannelState = {
  status: TelegramChannelStatus;
  configured: boolean;
  enabled: boolean;
  bot?: TelegramBotIdentity | null;
  owner?: TelegramOwner | null;
  activeChatId?: string | null;
  pairingRequests: TelegramPairingRequest[];
  pendingCount: number;
  error?: string | null;
};

export type TelegramInboundEvent = {
  id: string;
  updateId: number;
  messageId: number;
  remoteChatId: number;
  sender: TelegramOwner;
  text: string;
  receivedAt: number;
  kind: 'message' | 'newChat';
  status: 'pending' | 'running' | 'answered' | 'delivered';
  localChatId?: string | null;
  attempts: number;
  lastError?: string | null;
};

export type TelegramDeliveryResult = {
  delivered: boolean;
  error?: string | null;
};

export function telegramStatusLine(state: TelegramChannelState): string {
  const bot = state.bot?.username ? `@${state.bot.username}` : state.bot?.name || 'Telegram bot';
  switch (state.status) {
    case 'connecting':
      return `Connecting ${bot}…`;
    case 'awaitingPairing':
      return `${bot} is listening. Send it a DM, then approve the account here.`;
    case 'connected':
      return `${bot} is connected while Raynard is running.`;
    case 'error':
      return state.error || 'Telegram could not connect.';
    default:
      return 'Connect a BotFather bot to use Raynard from Telegram.';
  }
}

/**
 * Telegram's plain-text send keeps delivery predictable: malformed Markdown
 * must never turn a completed Raynard answer into a rejected Bot API call.
 * Preserve link destinations because citations and source links still matter.
 */
export function telegramPlainText(markdown: string): string {
  return markdown
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
      label.trim() ? `${label.trim()} (${url.trim()})` : url.trim()
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, url: string) =>
      label.trim() === url.trim() ? url.trim() : `${label.trim()} (${url.trim()})`
    )
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*```[^\n]*$/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
    .replace(/(^|[^_])_([^_\n]+)_/g, '$1$2')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function takeChunk(codepoints: string[], limit: number): { chunk: string; rest: string[] } {
  if (codepoints.length <= limit) return { chunk: codepoints.join(''), rest: [] };
  let boundary = limit;
  const minimum = Math.floor(limit * 0.6);
  for (let index = limit; index >= minimum; index -= 1) {
    if (codepoints[index] === '\n') {
      boundary = index;
      break;
    }
    if (boundary === limit && /\s/u.test(codepoints[index] || '')) boundary = index;
  }
  const chunk = codepoints.slice(0, boundary).join('').trimEnd();
  let restIndex = boundary;
  while (restIndex < codepoints.length && /\s/u.test(codepoints[restIndex])) restIndex += 1;
  return { chunk, rest: codepoints.slice(restIndex) };
}

export function telegramReplyChunks(markdown: string, limit = 4000): string[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Telegram chunk limit must be positive.');
  const plain = telegramPlainText(markdown) || 'Raynard returned an empty response.';
  const chunks: string[] = [];
  let remaining = Array.from(plain);
  while (remaining.length) {
    const next = takeChunk(remaining, limit);
    chunks.push(next.chunk || remaining.slice(0, limit).join(''));
    remaining = next.rest;
  }
  return chunks;
}
