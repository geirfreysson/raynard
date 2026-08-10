import { describe, expect, it } from 'vitest';
import {
  createAxisFormatter,
  formatFullNumber,
  maxAbsValue,
  resolveHighlight,
  xTickLayout
} from './chart-format';
import { parseChartSpec, type ChartRow, type ChartSeries } from './chart-spec';

const series = (...keys: string[]): ChartSeries[] => keys.map((key) => ({ key, label: key }));

function ticks(rows: ChartRow[], keys: string[], values: number[]): string[] {
  const format = createAxisFormatter(rows, series(...keys));
  return values.map((value) => format(value));
}

describe('maxAbsValue', () => {
  it('takes the largest magnitude across every series, ignoring gaps', () => {
    const rows: ChartRow[] = [
      { year: 2010, UK: 100308, Germany: null },
      { year: 2019, UK: -250000, Germany: 122617 }
    ];
    expect(maxAbsValue(rows, series('UK', 'Germany'))).toBe(250000);
  });

  it('is 0 when nothing is plottable', () => {
    expect(maxAbsValue([], series('UK'))).toBe(0);
    expect(maxAbsValue([{ year: 2010, UK: null }], series('UK'))).toBe(0);
    // A key that matches no column contributes nothing.
    expect(maxAbsValue([{ year: 2010, UK: 5 }], series('missing'))).toBe(0);
  });
});

describe('createAxisFormatter', () => {
  it('uses compact notation for large series', () => {
    const rows: ChartRow[] = [{ year: 2010, gdp: 100308 }, { year: 2023, gdp: 1500000000 }];
    expect(ticks(rows, ['gdp'], [100308, 1000000, 1500000000, 500000])).toEqual([
      '100.3K',
      '1M',
      '1.5B',
      '500K'
    ]);
  });

  it('keeps small values precise instead of collapsing them to zero', () => {
    // The regression that motivated the adaptive rule: blanket compact
    // formatting renders 0.045 as "0".
    const rows: ChartRow[] = [{ year: 2010, rate: 0.045 }, { year: 2011, rate: 0.03 }];
    expect(ticks(rows, ['rate'], [0.045, 0.03, 0])).toEqual(['0.045', '0.03', '0']);
  });

  it('scales decimals to magnitude without padding trailing zeros', () => {
    expect(ticks([{ x: 1, v: 3.2 }], ['v'], [1.5, 3.2])).toEqual(['1.5', '3.2']);
    expect(ticks([{ x: 1, v: 45 }], ['v'], [45, 45.5])).toEqual(['45', '45.5']);
    expect(ticks([{ x: 1, v: 1500 }], ['v'], [1500, 1234])).toEqual(['1,500', '1,234']);
  });

  it('picks one formatter for the whole axis from the largest series', () => {
    // A large series and a small one together: the axis must span both, so
    // compact wins and the shared scale stays consistent.
    const rows: ChartRow[] = [{ year: 2010, big: 2000000, small: 4 }];
    expect(ticks(rows, ['big', 'small'], [2000000, 4])).toEqual(['2M', '4']);
  });

  it('formats negatives and skips non-numeric ticks', () => {
    const format = createAxisFormatter([{ x: 1, v: 5000000 }], series('v'));
    expect(format(-1500000)).toBe('-1.5M');
    expect(format('abc')).toBe('');
    expect(format(null)).toBe('');
    expect(format(Number.NaN)).toBe('');
  });
});

describe('formatFullNumber', () => {
  it('keeps full precision with grouping', () => {
    expect(formatFullNumber(1250000)).toBe('1,250,000');
    expect(formatFullNumber(0.045)).toBe('0.045');
    expect(formatFullNumber(-3.2)).toBe('-3.2');
  });

  it('renders gaps and passes strings through', () => {
    expect(formatFullNumber(null)).toBe('—');
    expect(formatFullNumber(undefined)).toBe('—');
    expect(formatFullNumber('')).toBe('—');
    expect(formatFullNumber(Number.NaN)).toBe('—');
    expect(formatFullNumber('United Kingdom')).toBe('United Kingdom');
  });
});

describe('resolveHighlight', () => {
  const spec = (highlight: unknown, overrides: Record<string, unknown> = {}) => {
    const parsed = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'country',
        highlight,
        series: [{ key: 'UK', label: 'United Kingdom' }, { key: 'Germany' }],
        rows: [
          { country: 'United Kingdom', UK: 1, Germany: 2 },
          { country: 'France', UK: 3, Germany: 4 }
        ],
        ...overrides
      })
    );
    if (!parsed) throw new Error('expected a valid chart spec');
    return parsed;
  };

  it('matches a series by its label or its key', () => {
    expect([...resolveHighlight(spec(['United Kingdom'])).series]).toEqual(['UK']);
    expect([...resolveHighlight(spec(['Germany'])).series]).toEqual(['Germany']);
    // The label resolves to the series KEY the renderer draws with.
    expect([...resolveHighlight(spec(['UK'])).series]).toEqual(['UK']);
  });

  it('matches case-insensitively and ignores surrounding space', () => {
    const resolved = resolveHighlight(spec(['  uNiTeD kInGdOm  ']));
    expect([...resolved.series]).toEqual(['UK']);
    expect(resolved.active).toBe(true);
  });

  it('falls through to an x-axis category when no series matches', () => {
    const resolved = resolveHighlight(spec(['France']));
    expect([...resolved.series]).toEqual([]);
    // The canonical row spelling is returned, not the token's casing.
    expect([...resolved.categories]).toEqual(['France']);
    expect(resolved.active).toBe(true);
  });

  it('prefers a series over a category of the same name', () => {
    // "United Kingdom" is both a series label and a row value here.
    const resolved = resolveHighlight(spec(['United Kingdom']));
    expect([...resolved.series]).toEqual(['UK']);
    expect([...resolved.categories]).toEqual([]);
  });

  it('resolves series and category tokens together', () => {
    const resolved = resolveHighlight(spec(['Germany', 'France']));
    expect([...resolved.series]).toEqual(['Germany']);
    expect([...resolved.categories]).toEqual(['France']);
  });

  it('stays inactive when nothing matches, so the chart is left alone', () => {
    // The regression this guards: treating "no match" as "highlight nothing"
    // would mute every series at once.
    const resolved = resolveHighlight(spec(['Atlantis']));
    expect(resolved.active).toBe(false);
    expect(resolved.series.size).toBe(0);
    expect(resolved.categories.size).toBe(0);
  });

  it('is inactive when the spec carries no highlight', () => {
    expect(resolveHighlight(spec(undefined)).active).toBe(false);
    expect(resolveHighlight(spec([])).active).toBe(false);
  });
});

describe('xTickLayout', () => {
  const yearRows = (count: number): ChartRow[] =>
    Array.from({ length: count }, (_, i) => ({ year: String(2000 + i) }));

  it('leaves a short series horizontal', () => {
    expect(xTickLayout(yearRows(5), 'year')).toEqual({ angled: false, interval: 0, height: 0 });
  });

  it('angles a long series and reserves room for the labels', () => {
    const layout = xTickLayout(yearRows(20), 'year');
    expect(layout.angled).toBe(true);
    expect(layout.height).toBeGreaterThan(0);
    // 20 labels still fit under the ~30 cap, so none are dropped.
    expect(layout.interval).toBe(0);
  });

  it('angles sooner when the labels themselves are long', () => {
    const rows = [
      { country: 'United Kingdom' },
      { country: 'Germany' },
      { country: 'France' },
      { country: 'Italy' },
      { country: 'Netherlands' },
      { country: 'Luxembourg' }
    ];
    expect(xTickLayout(rows, 'country').angled).toBe(true);
    // The same count of short labels does not need rotating.
    expect(xTickLayout(yearRows(6), 'year').angled).toBe(false);
  });

  it('thins the ticks once even rotated labels would smear', () => {
    const layout = xTickLayout(yearRows(200), 'year');
    expect(layout.angled).toBe(true);
    expect(layout.interval).toBe(6);
    // Roughly 200 / 7 labels actually drawn.
    expect(Math.ceil(200 / (layout.interval + 1))).toBeLessThanOrEqual(30);
  });

  it('caps the reserved height for very long labels', () => {
    const rows = [{ name: 'x'.repeat(80) }, { name: 'y'.repeat(80) }, { name: 'z'.repeat(80) }];
    expect(xTickLayout(rows, 'name').height).toBeLessThanOrEqual(70);
  });

  it('stays horizontal when there are no usable labels', () => {
    expect(xTickLayout([], 'year')).toEqual({ angled: false, interval: 0, height: 0 });
    expect(xTickLayout([{ year: '' }], 'year')).toEqual({ angled: false, interval: 0, height: 0 });
  });
});
