import { describe, expect, it } from 'vitest';

import { getPath, interpolate, resolveRows } from '../result-card/resolve';
import { collectTemplateFields } from '../result-card/template-fields';
import type { CardBlock, CardTemplate } from '../result-card/types';
import { projectCardData } from './project';

const name = { singular: 'monster', plural: 'monsters' };

function template(layout: CardBlock[], title?: string): CardTemplate {
  return title ? { name, title, layout } : { name, layout };
}

/**
 * The property that makes projection safe: every value the renderer could read
 * out of the original resolves identically out of the projected copy. `resolve.ts`
 * is the only interpreter of `data`, so if these agree, nothing on screen changes.
 */
function expectRendersIdentically(
  original: unknown,
  projected: unknown,
  card: CardTemplate,
  options: { rowCap?: number } = {}
) {
  const { fields, tables } = collectTemplateFields(card);
  for (const field of fields) {
    expect(getPath(projected, field.path)).toEqual(getPath(original, field.path));
  }
  if (card.title) {
    expect(interpolate(card.title, projected)).toBe(interpolate(card.title, original));
  }
  for (const table of tables) {
    const before = resolveRows(original, table.rows);
    const after = resolveRows(projected, table.rows);
    const expected = options.rowCap === undefined ? before.length : Math.min(before.length, options.rowCap);
    expect(after.length).toBe(expected);
    after.forEach((row, index) => {
      for (const column of table.columns) {
        expect(getPath(row, column)).toEqual(getPath(before[index], column));
      }
    });
  }
}

describe('projectCardData', () => {
  it('keeps bound paths and drops everything else', () => {
    const card = template([{ component: 'KeyValue', pairs: [{ label: 'HP', field: 'monster.hp' }] }]);
    const data = {
      monster: { hp: 15, name: 'Orc', unusedHugeBlob: 'x'.repeat(5000) },
      alsoUnused: [1, 2, 3]
    };

    const result = projectCardData(data, card);
    expect(result).not.toBeNull();
    expect(result!.data).toEqual({ monster: { hp: 15 } });
    expectRendersIdentically(data, result!.data, card);
  });

  it('shrinks the serialized payload substantially', () => {
    const card = template([{ component: 'Badge', field: 'status' }]);
    const data = { status: 'ok', noise: Array.from({ length: 500 }, (_, i) => ({ i, pad: 'y'.repeat(50) })) };
    const projected = projectCardData(data, card)!.data;
    expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(data).length / 100);
  });

  it('narrows table rows to their column paths', () => {
    const card = template([
      {
        component: 'Table',
        columns: [
          { header: 'Year', field: 'year' },
          { header: 'Value', field: 'obs.value' }
        ],
        rows: 'series.rows'
      }
    ]);
    const data = {
      series: {
        rows: [
          { year: 2000, obs: { value: 281, unit: 'people', note: 'x'.repeat(200) }, extra: 1 },
          { year: 2001, obs: { value: 285, unit: 'people', note: 'y'.repeat(200) }, extra: 2 }
        ],
        meta: 'dropped'
      }
    };

    const result = projectCardData(data, card)!;
    expect(result.data).toEqual({
      series: { rows: [{ year: 2000, obs: { value: 281 } }, { year: 2001, obs: { value: 285 } }] }
    });
    expect(result.truncated).toEqual([]);
    expectRendersIdentically(data, result.data, card);
  });

  it('caps rows and reports what it cut', () => {
    const card = template([
      { component: 'Table', columns: [{ header: 'N', field: 'n' }], rows: 'rows' }
    ]);
    const data = { rows: Array.from({ length: 250 }, (_, index) => ({ n: index, pad: 'z'.repeat(80) })) };

    const result = projectCardData(data, card, { rowCap: 100 })!;
    expect(resolveRows(result.data, 'rows')).toHaveLength(100);
    expect(result.truncated).toEqual([{ rows: 'rows', shown: 100, total: 250 }]);
    expectRendersIdentically(data, result.data, card, { rowCap: 100 });
  });

  it('reports no truncation when the cap exceeds the row count', () => {
    const card = template([
      { component: 'Table', columns: [{ header: 'N', field: 'n' }], rows: 'rows' }
    ]);
    const data = { rows: [{ n: 1 }, { n: 2 }] };
    expect(projectCardData(data, card, { rowCap: 100 })!.truncated).toEqual([]);
  });

  it('refuses to project a template that renders the whole object', () => {
    expect(projectCardData({ anything: 1 }, template([{ component: 'Json' }]))).toBeNull();
  });

  it('carries whole rows verbatim when a column binds the row itself', () => {
    const card = template([
      { component: 'Table', columns: [{ header: 'Raw', field: '' }], rows: 'rows' }
    ]);
    const data = { rows: [{ a: 1, b: 2 }, { a: 3, b: 4 }] };
    const result = projectCardData(data, card, { rowCap: 1 })!;
    expect(resolveRows(result.data, 'rows')).toEqual([{ a: 1, b: 2 }]);
    expect(result.truncated).toEqual([{ rows: 'rows', shown: 1, total: 2 }]);
  });

  it('mirrors arrays so indexed paths and resolveRows still work', () => {
    const card = template([
      { component: 'Text', text: 'Top: {{holdings.0.symbol}}' },
      { component: 'Table', columns: [{ header: 'S', field: 'symbol' }], rows: 'holdings' }
    ]);
    const data = { holdings: [{ symbol: 'AAPL', weight: 0.1 }, { symbol: 'MSFT', weight: 0.2 }] };

    const projected = projectCardData(data, card)!.data;
    expect(Array.isArray((projected as { holdings: unknown }).holdings)).toBe(true);
    expect(getPath(projected, 'holdings.0.symbol')).toBe('AAPL');
    expect(resolveRows(projected, 'holdings')).toHaveLength(2);
    expectRendersIdentically(data, projected, card);
  });

  it('preserves an interpolated title and image alt', () => {
    const card = template(
      [{ component: 'Image', field: 'img', alt: '{{monster.name}}' }],
      '{{monster.name}} (CR {{monster.cr}})'
    );
    const data = { monster: { name: 'Orc', cr: 1, lore: 'x'.repeat(2000) }, img: 'https://e/o.png' };

    const projected = projectCardData(data, card)!.data;
    expect(projected).toEqual({ monster: { name: 'Orc', cr: 1 }, img: 'https://e/o.png' });
    expectRendersIdentically(data, projected, card);
  });

  it('is unbothered by paths the data does not have', () => {
    const card = template([
      { component: 'KeyValue', pairs: [{ label: 'Missing', field: 'a.b.c' }] }
    ]);
    const result = projectCardData({ other: 1 }, card)!;
    expect(result.data).toEqual({});
    expect(getPath(result.data, 'a.b.c')).toBeUndefined();
  });

  it('handles a null or scalar data blob without throwing', () => {
    const card = template([{ component: 'Badge', field: 'x' }]);
    expect(projectCardData(null, card)!.data).toEqual({});
    expect(projectCardData('a string', card)!.data).toEqual({});
  });
});
