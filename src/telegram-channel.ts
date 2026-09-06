import type { ChartSource } from './chart-sources';

export type TelegramChannelStatus =
  | 'disconnected'
  | 'connecting'
  | 'awaitingPairing'
  | 'connected'
  | 'error';

export type TelegramBotIdentity = { id: number; username: string; name: string };

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

export type TelegramDeliveryResult = { delivered: boolean; error?: string | null };

export type TelegramDeliveryPart =
  | { kind: 'text'; text: string; parseMode: 'HTML' }
  | { kind: 'rich'; html: string; fallbackText: string; fallbackParseMode: 'HTML' }
  | { kind: 'photo'; dataBase64: string; filename: string };

export type TelegramFormattedReply = {
  /** Text-only rendering retained for compatibility and deterministic tests. */
  chunks: string[];
  parseMode: 'HTML';
  /** Ordered durable units sent through sendMessage/sendRichMessage/sendPhoto. */
  parts: TelegramDeliveryPart[];
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function sourceUrls(sources: ChartSource[]): Set<string> {
  const urls = new Set<string>();
  for (const source of sources) {
    if (source.sourceUrl?.trim()) urls.add(source.sourceUrl.trim());
    for (const reference of source.references ?? []) {
      if (reference.sourceUrl?.trim()) urls.add(reference.sourceUrl.trim());
    }
  }
  return urls;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function usefulLinkLabel(label: string): string {
  const trimmed = label.trim();
  return /^(?:\d+|source|reference|citation)(?:\s*\d+)?$/i.test(trimmed) ? '' : trimmed;
}

/** Strip tool references from Telegram while leaving desktop source records intact. */
export function stripTelegramReferences(markdown: string, sources: ChartSource[] = []): string {
  const urls = sourceUrls(sources);
  let result = String(markdown || '').replace(/\[\^(?:\d{1,3})\]/g, '');

  result = result.replace(
    /\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)/g,
    (match, label: string, url: string) =>
      urls.has(url.trim()) ? usefulLinkLabel(label) : match
  );

  for (const url of urls) result = result.replace(new RegExp(escapeRegExp(url), 'g'), '');

  return result
    .replace(/\[([^\]]+)\]\(\s*\)/g, (_match, label: string) => usefulLinkLabel(label))
    .replace(/\(\s*\d+\s*\(\s*\)\s*\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/[ \t]+([,.;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const INLINE_MARKDOWN_PATTERN =
  /(?:`([^`]+)`)|(?:\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(?:\*\*([^*]+)\*\*)|(?:__([^_]+)__)|(?:~~([^~]+)~~)|(?:\*([^*\n]+)\*)|(?:_([^_\n]+)_)/g;

function renderInline(value: string, depth = 0): string {
  const source = String(value || '');
  if (depth > 3) return escapeHtml(source);
  const matches = Array.from(source.matchAll(INLINE_MARKDOWN_PATTERN));
  let result = '';
  let lastIndex = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    result += escapeHtml(source.slice(lastIndex, index));
    if (match[1]) result += `<code>${escapeHtml(match[1])}</code>`;
    else if (match[2] && match[3]) {
      result += `<a href="${escapeHtml(match[3])}">${renderInline(match[2], depth + 1)}</a>`;
    } else if (match[4] || match[5]) {
      result += `<b>${renderInline(match[4] || match[5], depth + 1)}</b>`;
    } else if (match[6]) result += `<s>${renderInline(match[6], depth + 1)}</s>`;
    else result += `<i>${renderInline(match[7] || match[8], depth + 1)}</i>`;
    lastIndex = index + match[0].length;
  }
  return result + escapeHtml(source.slice(lastIndex));
}

function splitTableRow(line: string): string[] {
  let trimmed = String(line || '').trim();
  if (!trimmed.includes('|')) return [];
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  if (!trimmed.includes('|')) return [];
  return trimmed.split('|').map((cell) => cell.trim());
}

function isTableDivider(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

type TelegramListItem = { marker: string; text: string };

/** Models often emit a literal bullet instead of Markdown's -, * or +. */
function telegramListItem(line: string): TelegramListItem | null {
  const bullet = String(line || '').trim().match(/^[-*+•]\s+(.+)$/);
  if (bullet) return { marker: '•', text: bullet[1] };
  const number = String(line || '').trim().match(/^(\d+)\.\s+(.+)$/);
  return number ? { marker: `${number[1]}.`, text: number[2] } : null;
}

function isBlockStart(lines: string[], index: number): boolean {
  const line = lines[index]?.trim() || '';
  return (
    !line || /^```/.test(line) || /^#{1,6}\s+/.test(line) || /^>\s?/.test(line) ||
    telegramListItem(line) !== null || /^-{3,}$/.test(line) ||
    (splitTableRow(line).length >= 2 && isTableDivider(lines[index + 1] || ''))
  );
}

type TelegramTextBlock = { kind: 'text'; html: string };
type TelegramTableBlock = { kind: 'table'; html: string; fallbackText: string };
type TelegramBlock = TelegramTextBlock | TelegramTableBlock;

const MAX_NATIVE_TABLE_COLUMNS = 3;
const MAX_NATIVE_TABLE_ROWS = 8;

function tableFallback(headers: string[], rows: string[][]): string {
  return rows.map((cells) => headers.map((header, cellIndex) => {
    const label = header || `Column ${cellIndex + 1}`;
    return `<b>${renderInline(label)}:</b> ${renderInline(cells[cellIndex] || '—')}`;
  }).join('\n')).join('\n\n');
}

function nativeTableHtml(headers: string[], rows: string[][]): string {
  const heading = `<tr>${headers.map((header, index) =>
    `<th>${renderInline(header || `Column ${index + 1}`)}</th>`
  ).join('')}</tr>`;
  const body = rows.map((cells) =>
    `<tr>${headers.map((_header, index) => `<td>${renderInline(cells[index] || '—')}</td>`).join('')}</tr>`
  ).join('');
  return `<table bordered striped compact>${heading}${body}</table>`;
}

function renderTelegramBlocks(markdown: string): TelegramBlock[] {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks: TelegramBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const trimmed = lines[index].trim();
    if (!trimmed || /^-{3,}$/.test(trimmed)) { index += 1; continue; }

    if (/^```/.test(trimmed)) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```/.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      blocks.push({ kind: 'text', html: `<pre><code>${escapeHtml(code.join('\n'))}</code></pre>` });
      continue;
    }

    const heading = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (heading) {
      const headingText = heading[1].replace(/^(?:\*\*([^*]+)\*\*|__([^_]+)__)$/, '$1$2');
      blocks.push({ kind: 'text', html: `<b>${renderInline(headingText)}</b>` });
      index += 1;
      continue;
    }

    if (/^>\s?/.test(trimmed)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
        quote.push(lines[index++].replace(/^\s*>\s?/, ''));
      }
      blocks.push({ kind: 'text', html: `<blockquote>${renderInline(quote.join('\n'))}</blockquote>` });
      continue;
    }

    const headers = splitTableRow(trimmed);
    if (headers.length >= 2 && isTableDivider(lines[index + 1] || '')) {
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length) {
        const cells = splitTableRow(lines[index]);
        if (cells.length < 2) break;
        rows.push(cells);
        index += 1;
      }
      if (rows.length) {
        const fallbackText = tableFallback(headers, rows);
        if (
          headers.length <= MAX_NATIVE_TABLE_COLUMNS &&
          rows.length <= MAX_NATIVE_TABLE_ROWS &&
          charCount(fallbackText) <= 4000
        ) {
          blocks.push({
            kind: 'table',
            html: nativeTableHtml(headers, rows),
            fallbackText
          });
        } else {
          blocks.push({ kind: 'text', html: fallbackText });
        }
      }
      continue;
    }

    const firstListItem = telegramListItem(trimmed);
    if (firstListItem) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = telegramListItem(lines[index]);
        if (!item) break;
        items.push(`${item.marker} ${renderInline(item.text)}`);
        index += 1;
      }
      // Telegram has no <ul>/<li> HTML. Blank lines give long, wrapped items
      // the same visual separation a browser list gets from its layout.
      blocks.push({ kind: 'text', html: items.join('\n\n') });
      continue;
    }

    const paragraph = [trimmed];
    index += 1;
    while (index < lines.length && !isBlockStart(lines, index)) paragraph.push(lines[index++].trim());
    blocks.push({ kind: 'text', html: renderInline(paragraph.join(' ')) });
  }
  return blocks;
}

function charCount(value: string): number { return Array.from(value).length; }

type OpenTag = { name: string; opening: string };

function updatedTags(tags: OpenTag[], token: string): OpenTag[] {
  const closing = token.match(/^<\/([a-z-]+)>$/i);
  if (closing) {
    const next = tags.slice();
    const match = next.map((tag) => tag.name).lastIndexOf(closing[1].toLowerCase());
    if (match >= 0) next.splice(match, 1);
    return next;
  }
  const opening = token.match(/^<([a-z-]+)(?:\s[^<>]*)?>$/i);
  return opening ? [...tags, { name: opening[1].toLowerCase(), opening: token }] : tags;
}

function closeTags(tags: OpenTag[]): string {
  return tags.slice().reverse().map((tag) => `</${tag.name}>`).join('');
}

function splitBalancedHtml(fragment: string, limit: number): string[] {
  const tokens = fragment.match(/<\/?[a-z-]+(?:\s[^<>]*?)?>|&(?:[a-z]+|#\d+|#x[a-f\d]+);|[\s\S]/gi) ?? [];
  const chunks: string[] = [];
  let tags: OpenTag[] = [];
  let current = '';
  for (const token of tokens) {
    const nextTags = updatedTags(tags, token);
    if (current && charCount(current + token + closeTags(nextTags)) > limit) {
      chunks.push((current + closeTags(tags)).trim());
      current = tags.map((tag) => tag.opening).join('');
    }
    current += token;
    tags = nextTags;
  }
  if (current) chunks.push((current + closeTags(tags)).trim());
  return chunks.filter(Boolean);
}

function chunkTelegramHtml(blocks: string[], limit: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    const candidate = current ? `${current}\n\n${block}` : block;
    if (charCount(candidate) <= limit) { current = candidate; continue; }
    if (current) chunks.push(current);
    if (charCount(block) <= limit) { current = block; continue; }
    const split = splitBalancedHtml(block, limit);
    chunks.push(...split.slice(0, -1));
    current = split.at(-1) || '';
  }
  if (current) chunks.push(current);
  return chunks;
}

function deliveryParts(blocks: TelegramBlock[], limit: number): TelegramDeliveryPart[] {
  const parts: TelegramDeliveryPart[] = [];
  let textBlocks: string[] = [];
  const flushText = () => {
    for (const text of chunkTelegramHtml(textBlocks, limit)) {
      parts.push({ kind: 'text', text, parseMode: 'HTML' });
    }
    textBlocks = [];
  };

  for (const block of blocks) {
    if (block.kind === 'text') {
      textBlocks.push(block.html);
      continue;
    }
    flushText();
    parts.push({
      kind: 'rich',
      html: block.html,
      fallbackText: block.fallbackText,
      fallbackParseMode: 'HTML'
    });
  }
  flushText();
  return parts;
}

/** Format a model answer for Telegram's safe HTML subset. */
export function telegramReply(markdown: string, sources: ChartSource[] = [], limit = 4000): TelegramFormattedReply {
  if (!Number.isInteger(limit) || limit < 32) throw new Error('Telegram chunk limit must be an integer of at least 32.');
  const clean = stripTelegramReferences(markdown, sources);
  const blocks = renderTelegramBlocks(clean || 'Raynard returned an empty response.');
  const chunks = chunkTelegramHtml(
    blocks.map((block) => block.kind === 'text' ? block.html : block.fallbackText),
    limit
  );
  return { chunks, parseMode: 'HTML', parts: deliveryParts(blocks, limit) };
}
