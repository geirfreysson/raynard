import { describe, expect, it } from 'vitest';

import type { ChartSource } from '../chart-sources';
import { resolveRows } from '../result-card/resolve';
import type { StoredResultCard } from '../result-card/types';
import { encodeSharePayload } from './codec';
import {
  SHARE_MAX_CARDS,
  SHARE_TABLE_ROW_CAP,
  SHARE_TABLE_ROW_CAP_TIGHT,
  SHARE_URL_BUDGET_CHARS,
  fitSharePayload
} from './degrade';
import { SHARE_PAYLOAD_VERSION } from './types';
import type { SharedAnswerPayload } from './types';

// The ladder's job is to measure and degrade, not to compress. Driving it with a
// plain JSON encoder makes every budget below an exact, readable number of
// characters; real deflate is exercised separately at the bottom of this file.
const jsonEncoder = async (candidate: SharedAnswerPayload) => JSON.stringify(candidate);

function tableCard(rowCount: number, singular = 'observation'): StoredResultCard {
  return {
    toolName: 'wb_series',
    template: {
      name: { singular, plural: `${singular}s` },
      layout: [
        {
          component: 'Table',
          columns: [
            { header: 'Year', field: 'year' },
            { header: 'Value', field: 'value' }
          ],
          rows: 'rows'
        }
      ]
    },
    data: {
      rows: Array.from({ length: rowCount }, (_, index) => ({
        year: 1960 + index,
        value: index * 1000,
        // Never bound by the template, so projection must drop it.
        note: `filler ${'x'.repeat(200)}`
      })),
      unused: 'y'.repeat(5000)
    }
  };
}

function payload(overrides: Partial<SharedAnswerPayload> = {}): SharedAnswerPayload {
  return {
    v: SHARE_PAYLOAD_VERSION,
    at: '2026-08-18T10:00:00.000Z',
    q: 'Population over time?',
    a: 'It rose steadily.',
    teaser: { cards: '1 observation', ext: 'World Bank Data360' },
    ...overrides
  };
}

function sourcesWithPayloads(): ChartSource[] {
  return [
    {
      plugin: 'World Bank Data360',
      references: [
        { label: 'Population, total', sourceUrl: 'https://x/1', payload: 'z'.repeat(4000), payloadTruncated: true },
        { label: 'GDP', sourceUrl: 'https://x/2', payload: 'w'.repeat(4000) }
      ]
    }
  ];
}

describe('fitSharePayload', () => {
  it('leaves a payload that already fits completely untouched', async () => {
    const original = payload();
    const fitted = await fitSharePayload(original, 100_000, jsonEncoder);
    expect(fitted.payload.degraded).toBeUndefined();
    expect(fitted.payload).toEqual(original);
  });

  it('reports the encoded length it actually measured', async () => {
    const fitted = await fitSharePayload(payload(), SHARE_URL_BUDGET_CHARS);
    expect(fitted.length).toBe(fitted.encoded.length);
    expect(fitted.encoded).toBe(await encodeSharePayload(fitted.payload));
    expect(fitted.encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('drops citation excerpts before touching card data', async () => {
    const fitted = await fitSharePayload(payload({ sources: sourcesWithPayloads() }), 1000, jsonEncoder);
    expect(fitted.payload.degraded).toEqual({ citationPayloads: true });
    expect(fitted.payload.degraded?.projected).toBeUndefined();

    const references = fitted.payload.sources![0].references!;
    expect(references.map((reference) => reference.label)).toEqual(['Population, total', 'GDP']);
    for (const reference of references) {
      expect(reference).not.toHaveProperty('payload');
      expect(reference).not.toHaveProperty('payloadTruncated');
      // Label and link are what make a citation checkable; they stay.
      expect(reference.sourceUrl).toMatch(/^https:\/\//);
    }
  });

  it('projects card data down to the paths the template reads', async () => {
    const fitted = await fitSharePayload(payload({ cards: [tableCard(20)] }), 3000, jsonEncoder);
    expect(fitted.payload.degraded?.projected).toBe(true);
    // Projection alone was enough, so no rows were lost.
    expect(fitted.payload.degraded?.rows).toBeUndefined();

    const json = JSON.stringify(fitted.payload.cards);
    expect(json).not.toContain('filler');
    expect(json).not.toContain('unused');
    expect(resolveRows(fitted.payload.cards![0].data, 'rows')).toHaveLength(20);
  });

  it('caps rows only when projection is not enough, and records the cut', async () => {
    const fitted = await fitSharePayload(payload({ cards: [tableCard(4000)] }), 10_000, jsonEncoder);
    const rows = fitted.payload.degraded?.rows;
    expect(rows).toHaveLength(1);
    expect(rows![0]).toEqual({ card: 0, shown: SHARE_TABLE_ROW_CAP, total: 4000 });
    expect(resolveRows(fitted.payload.cards![0].data, 'rows')).toHaveLength(SHARE_TABLE_ROW_CAP);
    expect(fitted.length).toBeLessThanOrEqual(10_000);
  });

  it('tightens the row cap before giving up on cards', async () => {
    const fitted = await fitSharePayload(payload({ cards: [tableCard(4000)] }), 1200, jsonEncoder);
    expect(fitted.payload.degraded?.rows).toEqual([
      { card: 0, shown: SHARE_TABLE_ROW_CAP_TIGHT, total: 4000 }
    ]);
    expect(fitted.payload.degraded?.droppedCards).toBeUndefined();
  });

  it('drops trailing cards last, and retells the teaser so it matches what travels', async () => {
    const cards = Array.from({ length: 9 }, () => tableCard(300));
    const fitted = await fitSharePayload(
      payload({ cards, teaser: { cards: '9 observations', ext: 'x' } }),
      5000,
      jsonEncoder
    );

    expect(fitted.payload.cards).toHaveLength(SHARE_MAX_CARDS);
    expect(fitted.payload.degraded?.droppedCards).toBe(9 - SHARE_MAX_CARDS);
    expect(fitted.payload.teaser.cards).toBe('5 observations');
    // Truncation entries for dropped cards would point at cards that no longer exist.
    for (const row of fitted.payload.degraded?.rows ?? []) {
      expect(row.card).toBeLessThan(SHARE_MAX_CARDS);
    }
  });

  it('flags overBudget instead of handing back a link that cannot work', async () => {
    // The answer text alone exceeds the budget, and text is never truncated.
    const fitted = await fitSharePayload(payload({ a: 'x'.repeat(5000) }), 500, jsonEncoder);
    expect(fitted.payload.degraded?.overBudget).toBe(true);
    expect(fitted.length).toBeGreaterThan(500);
  });

  it('never truncates the answer text', async () => {
    const answer = 'Detailed finding. '.repeat(500);
    const fitted = await fitSharePayload(
      payload({ a: answer, cards: [tableCard(2000)] }),
      1000,
      jsonEncoder
    );
    expect(fitted.payload.a).toBe(answer);
  });

  it('descends one rung at a time and stops at the first that fits', async () => {
    const seen: number[] = [];
    const fitted = await fitSharePayload(
      payload({ sources: sourcesWithPayloads(), cards: [tableCard(500)] }),
      4000,
      async (candidate) => {
        const encoded = await jsonEncoder(candidate);
        seen.push(encoded.length);
        return encoded;
      }
    );

    expect(seen.length).toBeGreaterThan(1);
    for (let index = 1; index < seen.length; index += 1) {
      expect(seen[index]).toBeLessThanOrEqual(seen[index - 1]);
    }
    expect(fitted.length).toBe(seen[seen.length - 1]);
    expect(fitted.length).toBeLessThanOrEqual(4000);
  });

  it('leaves a card whose template renders the whole object alone', async () => {
    const opaque: StoredResultCard = {
      toolName: 'raw',
      template: { name: { singular: 'blob', plural: 'blobs' }, layout: [{ component: 'Json' }] },
      data: { keep: 'everything', big: 'q'.repeat(3000) }
    };
    const fitted = await fitSharePayload(payload({ cards: [opaque] }), 500, jsonEncoder);
    expect(fitted.payload.cards![0].data).toEqual(opaque.data);
    expect(fitted.payload.degraded?.projected).toBeUndefined();
    expect(fitted.payload.degraded?.overBudget).toBe(true);
  });

  it('fits a realistic answer inside the real budget with real compression', async () => {
    // 200 observations plus citation excerpts: the shape of an ordinary World
    // Bank answer, which should need little or no degrading.
    const fitted = await fitSharePayload(
      payload({ cards: [tableCard(200)], sources: sourcesWithPayloads() })
    );
    expect(fitted.length).toBeLessThanOrEqual(SHARE_URL_BUDGET_CHARS);
    expect(fitted.payload.degraded?.overBudget).toBeUndefined();
    expect(fitted.payload.degraded?.droppedCards).toBeUndefined();
  });
});
