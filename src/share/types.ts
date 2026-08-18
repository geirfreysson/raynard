import type { ChartSource } from '../chart-sources';
import type { StoredResultCard } from '../result-card/types';

// The wire format for a shared answer.
//
// A share link carries the whole payload in the URL fragment, so nothing is ever
// sent to a server and there is nothing to store. That makes the payload the
// entire contract: it has to be self-describing, small enough to survive a chat
// client, and free of anything that identifies the sender or points at files on
// their machine.

export const SHARE_PAYLOAD_VERSION = 1;

/**
 * What the landing page shows without decoding a single card.
 *
 * Precomputed here so `docs/` needs no copy of `cardCountLabel`, `resolve.ts`,
 * or the React card renderer — the page reads three strings and stops.
 */
export type ShareTeaser = {
  /** Count label, e.g. `2 monsters · 1 spell`. */
  cards: string;
  /** Plugin display names that fed the answer, joined for display. */
  ext: string;
};

/** One extension that produced part of the answer, so a recipient can install it. */
export type ShareExtension = {
  /** Catalog slug. Absent for a user-built plugin, which has nothing to install. */
  slug?: string;
  name: string;
  description?: string;
};

/** What `fitSharePayload` gave up to get under the URL budget. */
export type ShareDegradation = {
  /** Tables that lost rows, indexed into `cards`. */
  rows?: { card: number; shown: number; total: number }[];
  /** Cards dropped off the tail. */
  droppedCards?: number;
  /** Raw API excerpts removed from citations. */
  citationPayloads?: boolean;
  /** Card data narrowed to the paths its template reads. */
  projected?: boolean;
  /** True when even the last rung did not fit; the caller must not offer a link. */
  overBudget?: boolean;
};

export type SharedAnswerPayload = {
  v: typeof SHARE_PAYLOAD_VERSION;
  /** ISO-8601 instant the link was created. */
  at: string;
  /** The question that produced the answer. */
  q: string;
  /** The answer, verbatim markdown. Chart fences carry their own rows inline. */
  a: string;
  teaser: ShareTeaser;
  ext?: ShareExtension[];
  cards?: StoredResultCard[];
  sources?: ChartSource[];
  degraded?: ShareDegradation;
};

/** Thrown when a link cannot be read, so callers can say so instead of half-rendering. */
export class ShareLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShareLinkError';
  }
}
