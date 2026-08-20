import type { ChartSource } from '../chart-sources';
import { cardSummaryLabel } from '../result-card/ResultCardStack';
import type { StoredResultCard } from '../result-card/types';
import { SHARE_PAYLOAD_VERSION, ShareLinkError } from './types';
import type { ShareExtension, SharedAnswerPayload } from './types';

export type ShareSourceMessage = {
  text: string;
  cards?: StoredResultCard[];
  sources?: ChartSource[];
};

export type ShareSource = {
  question: string;
  /** Cards must already be hydrated — see the artifact note below. */
  message: ShareSourceMessage;
  extensions: ShareExtension[];
  now?: () => number;
};

/**
 * Drop the artifact ref. It names a file under the *sender's* app data
 * (`result-artifacts/<chatId>/…`), which is meaningless to a recipient and
 * leaks a local chat id.
 */
function shareableCard(card: StoredResultCard, index: number): StoredResultCard {
  if (card.artifact) {
    // The caller must run `hydrateResultCards` first. Sharing an unhydrated card
    // would send `data: {}` and render an empty card with no hint anything was lost.
    throw new ShareLinkError(
      `Card ${index + 1} still points at a local artifact; hydrate cards before sharing.`
    );
  }
  const { artifact: _artifact, ...rest } = card;
  return rest;
}

/**
 * Assemble the wire payload for one assistant answer.
 *
 * Everything not listed here is deliberately left behind: `usage`, `provider`,
 * `model`, `thinking`, builder activity, credential requests, timestamps, and
 * the chat id. Nothing in the result identifies the sender.
 */
export function buildSharePayload(source: ShareSource): SharedAnswerPayload {
  const cards = (source.message.cards ?? []).map(shareableCard);
  const sources = source.message.sources ?? [];
  const extensions = source.extensions ?? [];

  const payload: SharedAnswerPayload = {
    v: SHARE_PAYLOAD_VERSION,
    at: new Date(source.now ? source.now() : Date.now()).toISOString(),
    q: source.question.trim(),
    a: source.message.text,
    teaser: {
      cards: cardSummaryLabel(cards),
      ext: extensions
        .map((extension) => extension.name.trim())
        .filter(Boolean)
        .join(' · ')
    }
  };

  if (extensions.length) payload.ext = extensions;
  if (cards.length) payload.cards = cards;
  if (sources.length) payload.sources = sources;
  return payload;
}
