import type { ChartSource } from '../chart-sources';
import type { ExtensionRecommendation } from '../extension-recommendation';
import type { StoredResultCard } from '../result-card/types';
import type { SharedAnswerPayload } from './types';

// Turn a decoded payload back into the two messages a chat is made of.
//
// Kept separate from main.ts so the shape of an imported answer is testable
// without a DOM: the host only has to push these into `storedMessages` and
// re-render.

export type ImportedShareMessage = {
  role: 'user' | 'assistant';
  text: string;
  timestamp: number;
  status?: 'completed';
  cards?: StoredResultCard[];
  sources?: ChartSource[];
};

export type ImportedShare = {
  user: ImportedShareMessage;
  assistant: ImportedShareMessage;
};

export function messagesFromSharedPayload(
  payload: SharedAnswerPayload,
  now: number = Date.now()
): ImportedShare {
  const assistant: ImportedShareMessage = {
    role: 'assistant',
    text: payload.a,
    // One millisecond after the question so the pair sorts and renders in order.
    timestamp: now + 1,
    status: 'completed'
  };
  if (payload.cards?.length) assistant.cards = payload.cards;
  if (payload.sources?.length) assistant.sources = payload.sources;

  return {
    user: { role: 'user', text: payload.q, timestamp: now },
    assistant
  };
}

/** A catalog entry as the host knows it, narrowed to what the nudge needs. */
export type ShareCatalogEntry = {
  slug: string;
  name: string;
  description: string;
  installed: boolean;
};

/**
 * Pick the extension to offer installing alongside an imported answer.
 *
 * Only bundled catalog extensions carry a slug, so a user-built plugin yields no
 * recommendation — there would be nothing to install. The returned shape is what
 * `decodeExtensionRecommendation` accepts, so the existing inline install card
 * renders it with no new UI.
 */
export function recommendationForShare(
  payload: SharedAnswerPayload,
  catalog: ShareCatalogEntry[]
): ExtensionRecommendation | null {
  const answer = payload.a.trim();
  if (!answer) return null;

  for (const extension of payload.ext ?? []) {
    const slug = (extension.slug || '').trim();
    if (!slug) continue;
    const entry = catalog.find((candidate) => candidate.slug === slug);
    if (!entry || entry.installed) continue;
    return {
      slug,
      name: entry.name || extension.name,
      description: entry.description || extension.description || '',
      answer
    };
  }

  return null;
}
