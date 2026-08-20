import { cardSummaryLabel } from '../result-card/ResultCardStack';
import { encodeSharePayload } from './codec';
import { projectCardData } from './project';
import type { ShareDegradation, SharedAnswerPayload } from './types';

// Fit a payload into a URL, and say exactly what was given up to get there.
//
// The budget is 8192 encoded characters. Browsers allow far more (Chrome ~2 MB,
// Safari ~80 KB) and a fragment is never sent to a server, so no request-line
// limit applies. The real constraint is the chat client in between: plaintext
// email hard-wraps at RFC 5322's 998 octets and can silently corrupt a long URL.
//
// Rung ordering comes from measuring 290 real answers: dropping citation
// excerpts and projecting card data do almost all the work, while row capping
// alone barely moves the number because the outliers are fat objects, not long
// tables.

export const SHARE_URL_BUDGET_CHARS = 8192;
export const SHARE_TABLE_ROW_CAP = 100;
export const SHARE_TABLE_ROW_CAP_TIGHT = 25;
export const SHARE_MAX_CARDS = 5;

export type SizedShare = {
  payload: SharedAnswerPayload;
  encoded: string;
  length: number;
};

function withDegradation(
  payload: SharedAnswerPayload,
  patch: Partial<ShareDegradation>
): SharedAnswerPayload {
  return { ...payload, degraded: { ...payload.degraded, ...patch } };
}

/**
 * Remove raw API excerpts from citations. Near-lossless: the citation modal
 * prefers the result card over the raw payload, and label plus source URL are
 * what make a citation checkable.
 */
function dropCitationPayloads(payload: SharedAnswerPayload): SharedAnswerPayload {
  if (!payload.sources?.length) return payload;

  let changed = false;
  const sources = payload.sources.map((source) => {
    if (!source.references?.length) return source;
    const references = source.references.map((reference) => {
      if (reference.payload === undefined && reference.payloadTruncated === undefined) {
        return reference;
      }
      changed = true;
      const { payload: _payload, payloadTruncated: _truncated, ...rest } = reference;
      return rest;
    });
    return { ...source, references };
  });

  if (!changed) return payload;
  return withDegradation({ ...payload, sources }, { citationPayloads: true });
}

/** Narrow every card's data to the paths its template reads, optionally capping table rows. */
function projectCards(payload: SharedAnswerPayload, rowCap?: number): SharedAnswerPayload {
  if (!payload.cards?.length) return payload;

  const rows: NonNullable<ShareDegradation['rows']> = [];
  let projected = false;

  const cards = payload.cards.map((card, index) => {
    const result = projectCardData(card.data, card.template, { rowCap });
    // Null means a fieldless `Json` block renders the whole object; leave it alone.
    if (!result) return card;
    projected = true;
    for (const truncation of result.truncated) {
      rows.push({ card: index, shown: truncation.shown, total: truncation.total });
    }
    return { ...card, data: result.data };
  });

  if (!projected) return payload;
  const patch: Partial<ShareDegradation> = { projected: true };
  if (rows.length) patch.rows = rows;
  return withDegradation({ ...payload, cards }, patch);
}

/** Keep the leading cards only. The teaser is recomputed so it describes what actually travels. */
function limitCards(payload: SharedAnswerPayload, max: number): SharedAnswerPayload {
  if (!payload.cards || payload.cards.length <= max) return payload;

  const cards = payload.cards.slice(0, max);
  const droppedCards = payload.cards.length - max;
  const keptRows = payload.degraded?.rows?.filter((row) => row.card < max);

  const patch: Partial<ShareDegradation> = { droppedCards };
  if (keptRows) patch.rows = keptRows.length ? keptRows : undefined;

  return withDegradation(
    {
      ...payload,
      cards,
      teaser: { ...payload.teaser, cards: cardSummaryLabel(cards) }
    },
    patch
  );
}

/**
 * Encode, measure, and degrade until the link fits.
 *
 * Each rung is derived from the original payload rather than from the previous
 * rung, so the ladder cannot accumulate half-applied state. If nothing fits, the
 * smallest form is returned with `degraded.overBudget` set — the caller must
 * then refuse to present a link rather than hand over a truncated one.
 *
 * The answer text is never shortened. An answer that blows the budget on prose
 * alone is a genuine "this cannot be shared as a link", not something to trim.
 */
export async function fitSharePayload(
  payload: SharedAnswerPayload,
  budget: number = SHARE_URL_BUDGET_CHARS,
  encode: (candidate: SharedAnswerPayload) => Promise<string> = encodeSharePayload
): Promise<SizedShare> {
  const rungs: (() => SharedAnswerPayload)[] = [
    () => payload,
    () => dropCitationPayloads(payload),
    () => projectCards(dropCitationPayloads(payload)),
    () => projectCards(dropCitationPayloads(payload), SHARE_TABLE_ROW_CAP),
    () => projectCards(dropCitationPayloads(payload), SHARE_TABLE_ROW_CAP_TIGHT),
    () =>
      limitCards(
        projectCards(dropCitationPayloads(payload), SHARE_TABLE_ROW_CAP_TIGHT),
        SHARE_MAX_CARDS
      )
  ];

  let smallest: SizedShare | null = null;
  for (const rung of rungs) {
    const candidate = rung();
    const encoded = await encode(candidate);
    smallest = { payload: candidate, encoded, length: encoded.length };
    if (encoded.length <= budget) return smallest;
  }

  const overBudget = withDegradation(smallest!.payload, { overBudget: true });
  const encoded = await encode(overBudget);
  return { payload: overBudget, encoded, length: encoded.length };
}
