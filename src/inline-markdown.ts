/**
 * Inline markdown for one line of assistant output.
 *
 * A block renderer hands this a single run of text — a paragraph, a heading, a
 * table cell, a list item — and it appends the spans inside it: code, links,
 * emphasis, and the `[^n]` citation markers the main-agent prompt teaches the
 * model to write. Block structure is the caller's job; this only fills a node.
 */

import type { ChartSource } from './chart-sources';
import { createInlineCitation } from './citation-modal';
import type { StoredResultCard } from './result-card/types';

/**
 * What a rendered assistant message knows about the turn behind it: the API
 * calls it cited, and the result cards those calls produced. A citation points
 * at a card by index, so the rows are stored once and read from here.
 */
export type MessageContext = {
  sources: ChartSource[];
  cards: StoredResultCard[];
};

export const EMPTY_MESSAGE_CONTEXT: MessageContext = { sources: [], cards: [] };

export function messageContext(record: {
  sources?: ChartSource[];
  cards?: StoredResultCard[];
}): MessageContext {
  return { sources: record.sources ?? [], cards: record.cards ?? [] };
}

// The trailing alternative is a citation marker the model wrote, e.g. [^3].
const INLINE_MARKDOWN_PATTERN =
  /(?:`([^`]+)`)|(?:\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))|(?:\*\*([^*]+)\*\*)|(?:__([^_]+)__)|(?:\*([^*]+)\*)|(?:_([^_]+)_)|(?:\[\^(\d{1,3})\])/g;

/**
 * How deep emphasis may nest before the rest is left as literal text.
 *
 * Every delimiter pair strips at least two characters, so the recursion below
 * always terminates on its own; the cap only bounds the stack on pathological
 * input like a line of a hundred asterisks.
 */
const MAX_INLINE_MARKDOWN_DEPTH = 4;

export function appendInlineMarkdownSafe(
  container: HTMLElement,
  text: string,
  context: MessageContext = EMPTY_MESSAGE_CONTEXT,
  depth = 0
) {
  const source = String(text || '');

  // Matched up front rather than while appending, because emphasis recurses
  // into this same function and the pattern is a shared stateful `g` regex:
  // a nested walk would otherwise leave `lastIndex` past the outer position.
  const matches: RegExpExecArray[] = [];
  INLINE_MARKDOWN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_MARKDOWN_PATTERN.exec(source))) {
    matches.push(match);
  }

  let lastIndex = 0;

  for (const span of matches) {
    if (span.index > lastIndex) {
      container.appendChild(document.createTextNode(source.slice(lastIndex, span.index)));
    }

    if (span[1]) {
      const code = document.createElement('code');
      code.textContent = span[1];
      container.appendChild(code);
    } else if (span[2] && span[3]) {
      // No target="_blank": the delegated handler forwards the click to the OS browser.
      const link = document.createElement('a');
      link.href = span[3];
      link.rel = 'noreferrer noopener';
      link.textContent = span[2];
      container.appendChild(link);
    } else if (span[4] || span[5]) {
      const strong = document.createElement('strong');
      appendEmphasisContent(strong, span[4] || span[5], context, depth);
      container.appendChild(strong);
    } else if (span[6] || span[7]) {
      const emphasis = document.createElement('em');
      appendEmphasisContent(emphasis, span[6] || span[7], context, depth);
      container.appendChild(emphasis);
    } else if (span[8]) {
      // A marker for a reference this turn never issued cites nothing, so it
      // stays the literal text the model wrote rather than becoming a chip.
      const citation = createInlineCitation(Number(span[8]), context.sources, context.cards);
      container.appendChild(citation ?? document.createTextNode(span[0]));
    }

    lastIndex = span.index + span[0].length;
  }

  if (lastIndex < source.length) {
    container.appendChild(document.createTextNode(source.slice(lastIndex)));
  }
}

/**
 * Fills a `<strong>` or `<em>` with the inline markdown inside it.
 *
 * Emphasis used to be filled with `textContent`, which silently swallowed
 * everything it wrapped. Models routinely write their attribution as one
 * italic line — `*Sources: [^7], [^8]*` — and every marker in it rendered as
 * the literal `[^7]` instead of a clickable citation chip. Links and inline
 * code inside emphasis were lost the same way.
 */
function appendEmphasisContent(
  container: HTMLElement,
  text: string,
  context: MessageContext,
  depth: number
) {
  if (depth >= MAX_INLINE_MARKDOWN_DEPTH) {
    container.textContent = text;
    return;
  }
  appendInlineMarkdownSafe(container, text, context, depth + 1);
}
