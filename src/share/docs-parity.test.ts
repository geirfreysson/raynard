import { describe, expect, it } from 'vitest';

import {
  decodeSharePayload as decodeInDocs,
  degradationLine,
  teaserLine,
  SHARE_PAYLOAD_VERSION as DOCS_VERSION
} from '../../docs/src/lib/share-link.js';
import type { StoredResultCard } from '../result-card/types';
import { encodeSharePayload } from './codec';
import { fitSharePayload } from './degrade';
import { buildSharePayload } from './payload';
import { describeDegradation } from './share-modal';
import { SHARE_PAYLOAD_VERSION } from './types';

// The docs site carries its own decoder because it cannot import the app's
// TypeScript. That duplication is only safe if it is checked: this file encodes
// with the app and decodes with the docs copy, and compares the strings each
// side would show. If either drifts, this fails rather than a share link
// quietly rendering nothing on the landing page.

function card(rows: number): StoredResultCard {
  return {
    toolName: 'wb_series',
    template: {
      name: { singular: 'observation', plural: 'observations' },
      layout: [
        { component: 'Table', columns: [{ header: 'Year', field: 'year' }], rows: 'rows' }
      ]
    },
    data: { rows: Array.from({ length: rows }, (_, i) => ({ year: 1960 + i, pad: 'x'.repeat(60) })) }
  };
}

describe('docs share-link decoder parity', () => {
  it('agrees on the payload version', () => {
    expect(DOCS_VERSION).toBe(SHARE_PAYLOAD_VERSION);
  });

  it('decodes what the app encodes', async () => {
    const payload = buildSharePayload({
      question: 'How did the population change?',
      message: { text: 'It rose steadily.[^1]', cards: [card(3)] },
      extensions: [{ slug: 'world-bank-data360', name: 'World Bank Data360' }],
      now: () => Date.parse('2026-08-18T10:00:00.000Z')
    });

    const decoded = await decodeInDocs(await encodeSharePayload(payload));
    expect(decoded).toEqual(payload);
  });

  it('round-trips unicode', async () => {
    const payload = buildSharePayload({
      question: 'Hvað búa margir á Íslandi? 🇮🇸',
      message: { text: '~390.000 — “about”' },
      extensions: [],
      now: () => 0
    });
    const decoded = await decodeInDocs(await encodeSharePayload(payload));
    expect(decoded.q).toBe(payload.q);
    expect(decoded.a).toBe(payload.a);
  });

  it('renders the same teaser line the app precomputed', async () => {
    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a', cards: [card(2), card(2)] },
      extensions: [{ name: 'World Bank Data360' }],
      now: () => 0
    });
    const decoded = await decodeInDocs(await encodeSharePayload(payload));
    expect(teaserLine(decoded)).toBe('2 observations · World Bank Data360');
  });

  it('phrases degradation identically on both sides', async () => {
    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a', cards: Array.from({ length: 9 }, () => card(4000)) },
      extensions: [],
      now: () => 0
    });
    const fitted = await fitSharePayload(payload);
    expect(fitted.payload.degraded).toBeTruthy();

    const decoded = await decodeInDocs(fitted.encoded);
    expect(degradationLine(decoded)).toBe(describeDegradation(fitted.payload));
  });

  it('stays silent about projection on both sides', async () => {
    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a', cards: [card(40)] },
      extensions: [],
      now: () => 0
    });
    // Force projection without row capping by using a budget between the two.
    const fitted = await fitSharePayload(payload, 900);
    const decoded = await decodeInDocs(fitted.encoded);
    expect(degradationLine(decoded)).toBe(describeDegradation(fitted.payload));
  });

  it('rejects the same junk the app rejects', async () => {
    await expect(decodeInDocs('not-a-real-payload')).rejects.toThrow();
    await expect(decodeInDocs('')).rejects.toThrow();
  });

  it('rejects a payload from a newer version', async () => {
    const encoded = await encodeSharePayload({
      v: (SHARE_PAYLOAD_VERSION + 1) as typeof SHARE_PAYLOAD_VERSION,
      at: '2026-08-18T10:00:00.000Z',
      q: 'q',
      a: 'a',
      teaser: { cards: '', ext: '' }
    });
    await expect(decodeInDocs(encoded)).rejects.toThrow(/newer version/);
  });
});
