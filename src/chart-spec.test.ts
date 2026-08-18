import { describe, expect, it } from 'vitest';
import {
  MAX_CHART_HIGHLIGHTS,
  MAX_CHART_ROWS,
  MAX_CHART_SERIES,
  MAX_CHART_SOURCES,
  parseChartSpec,
  toChartNumber
} from './chart-spec';

const lineSpec = JSON.stringify({
  type: 'line',
  title: 'GDP per person employed (constant 2021 PPP$)',
  x: 'year',
  yLabel: 'PPP$',
  series: [{ key: 'UK', label: 'United Kingdom' }, { key: 'Germany' }],
  rows: [
    { year: 2010, UK: 100308, Germany: 115039 },
    { year: 2023, UK: 107289, Germany: 123751 }
  ]
});

describe('parseChartSpec', () => {
  it('parses a line spec and defaults a series label to its key', () => {
    const spec = parseChartSpec(lineSpec);
    expect(spec).not.toBeNull();
    expect(spec?.type).toBe('line');
    expect(spec?.title).toBe('GDP per person employed (constant 2021 PPP$)');
    expect(spec?.x).toBe('year');
    expect(spec?.yLabel).toBe('PPP$');
    expect(spec?.series).toEqual([
      { key: 'UK', label: 'United Kingdom' },
      { key: 'Germany', label: 'Germany' }
    ]);
    expect(spec?.rows[0]).toEqual({ year: 2010, UK: 100308, Germany: 115039 });
  });

  it('parses a dual-axis chart while leaving ordinary series on the left axis', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'year',
        yLabel: 'International $',
        rightYLabel: '% of exports',
        series: [
          { key: 'gdp', label: 'GDP per capita' },
          { key: 'metals', label: 'Ores & metals exports', axis: 'right' },
          { key: 'food', label: 'Food exports', axis: 'right' }
        ],
        rows: [{ year: 2024, gdp: 67310, metals: 34.3, food: 44 }]
      })
    );

    expect(spec?.rightYLabel).toBe('% of exports');
    expect(spec?.series).toEqual([
      { key: 'gdp', label: 'GDP per capita' },
      { key: 'metals', label: 'Ores & metals exports', axis: 'right' },
      { key: 'food', label: 'Food exports', axis: 'right' }
    ]);
  });

  it('rejects invalid or ambiguous dual-axis declarations', () => {
    const base = {
      type: 'line',
      x: 'year',
      series: [{ key: 'gdp' }, { key: 'rate', axis: 'right' }],
      rows: [{ year: 2024, gdp: 67310, rate: 44 }]
    };

    expect(
      parseChartSpec(
        JSON.stringify({ ...base, series: [{ key: 'gdp' }, { key: 'rate', axis: 'center' }] })
      )
    ).toBeNull();
    expect(
      parseChartSpec(
        JSON.stringify({ ...base, series: [{ key: 'gdp', axis: 'right' }, { key: 'rate', axis: 'right' }] })
      )
    ).toBeNull();
    expect(parseChartSpec(JSON.stringify({ ...base, type: 'bar', stacked: true }))).toBeNull();
  });

  it('keeps stacked only for bar charts', () => {
    const bar = parseChartSpec(
      JSON.stringify({
        type: 'bar',
        x: 'country',
        stacked: true,
        series: [{ key: 'value' }],
        rows: [{ country: 'UK', value: 12 }]
      })
    );
    expect(bar?.type).toBe('bar');
    expect(bar?.stacked).toBe(true);

    const line = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'year',
        stacked: true,
        series: [{ key: 'value' }],
        rows: [{ year: 2020, value: 12 }]
      })
    );
    expect(line?.stacked).toBeUndefined();
  });

  it('coerces numeric strings and blanks unusable cells instead of guessing', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'year',
        series: [{ key: 'value' }],
        rows: [
          { year: 2010, value: '1,003.08' },
          { year: 2011, value: '18%' },
          { year: 2012, value: 'not stated' },
          { year: 2013, value: null }
        ]
      })
    );
    expect(spec?.rows.map((row) => row.value)).toEqual([1003.08, 18, null, null]);
  });

  it('rejects a type the renderer cannot draw', () => {
    const source = JSON.stringify({
      type: 'pie',
      x: 'country',
      series: [{ key: 'value' }],
      rows: [{ country: 'UK', value: 1 }]
    });
    expect(parseChartSpec(source)).toBeNull();
  });

  it('rejects structurally incomplete specs', () => {
    const base = {
      type: 'line',
      x: 'year',
      series: [{ key: 'value' }],
      rows: [{ year: 2010, value: 1 }]
    };
    expect(parseChartSpec(JSON.stringify({ ...base, x: '   ' }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ ...base, series: [] }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ ...base, series: [{ label: 'no key' }] }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ ...base, rows: [] }))).toBeNull();
    expect(parseChartSpec(JSON.stringify({ ...base, rows: [['not', 'an', 'object']] }))).toBeNull();
    expect(
      parseChartSpec(
        JSON.stringify({ ...base, series: [{ key: 'a' }, { key: 'a' }] })
      )
    ).toBeNull();
  });

  it('rejects a spec whose series keys match nothing in the rows', () => {
    const source = JSON.stringify({
      type: 'line',
      x: 'year',
      series: [{ key: 'gdp' }],
      rows: [{ year: 2010, value: 100 }, { year: 2011, value: 120 }]
    });
    expect(parseChartSpec(source)).toBeNull();
  });

  it('truncates beyond the series and row caps', () => {
    const series = Array.from({ length: MAX_CHART_SERIES + 4 }, (_, i) => ({ key: `s${i}` }));
    const rows = Array.from({ length: MAX_CHART_ROWS + 50 }, (_, i) => ({
      year: 2000 + i,
      s0: i
    }));
    const spec = parseChartSpec(JSON.stringify({ type: 'line', x: 'year', series, rows }));
    expect(spec?.series).toHaveLength(MAX_CHART_SERIES);
    expect(spec?.rows).toHaveLength(MAX_CHART_ROWS);
  });

  it('collects the citation numbers whose rows were plotted', () => {
    const base = {
      type: 'line',
      x: 'year',
      series: [{ key: 'UK' }],
      rows: [{ year: 2010, UK: 1 }]
    };
    expect(parseChartSpec(JSON.stringify({ ...base, sources: [7, 9, 7] }))?.sources).toEqual([7, 9]);
    // Models write the marker rather than the bare number often enough to accept it.
    expect(parseChartSpec(JSON.stringify({ ...base, sources: ['[^3]', '4'] }))?.sources).toEqual([
      3, 4
    ]);
  });

  it('never fails a good spec over a bad source list', () => {
    const base = {
      type: 'line',
      x: 'year',
      series: [{ key: 'UK' }],
      rows: [{ year: 2010, UK: 1 }]
    };
    for (const sources of [[], ['x'], [0, -2, 1.5], {}, 'two', null]) {
      const spec = parseChartSpec(JSON.stringify({ ...base, sources }));
      expect(spec).not.toBeNull();
      expect(spec?.sources).toBeUndefined();
    }
    expect(parseChartSpec(JSON.stringify(base))?.sources).toBeUndefined();
  });

  it('caps the number of chart sources', () => {
    const sources = Array.from({ length: MAX_CHART_SOURCES + 5 }, (_, i) => i + 1);
    const spec = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'year',
        sources,
        series: [{ key: 'UK' }],
        rows: [{ year: 2010, UK: 1 }]
      })
    );
    expect(spec?.sources).toHaveLength(MAX_CHART_SOURCES);
  });

  it('collects highlight tokens, trimmed and de-duplicated', () => {
    const spec = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'year',
        highlight: ['  United Kingdom  ', 'Germany', 'united kingdom'],
        series: [{ key: 'UK' }],
        rows: [{ year: 2010, UK: 1 }]
      })
    );
    expect(spec?.highlight).toEqual(['United Kingdom', 'Germany']);
  });

  it('never fails a good spec over a bad highlight', () => {
    const base = {
      type: 'line',
      x: 'year',
      series: [{ key: 'UK' }],
      rows: [{ year: 2010, UK: 1 }]
    };
    // Each of these still yields a chart, just without a highlight.
    for (const highlight of [[], ['   '], [null, 42, {}], 'United Kingdom', 7, null]) {
      const spec = parseChartSpec(JSON.stringify({ ...base, highlight }));
      expect(spec).not.toBeNull();
      expect(spec?.highlight).toBeUndefined();
    }
    // Absent entirely.
    expect(parseChartSpec(JSON.stringify(base))?.highlight).toBeUndefined();
  });

  it('caps the number of highlights', () => {
    const highlight = Array.from({ length: MAX_CHART_HIGHLIGHTS + 5 }, (_, i) => `s${i}`);
    const spec = parseChartSpec(
      JSON.stringify({
        type: 'line',
        x: 'year',
        highlight,
        series: [{ key: 'UK' }],
        rows: [{ year: 2010, UK: 1 }]
      })
    );
    expect(spec?.highlight).toHaveLength(MAX_CHART_HIGHLIGHTS);
  });

  it('rejects bodies that are not a JSON object', () => {
    expect(parseChartSpec('')).toBeNull();
    expect(parseChartSpec('   ')).toBeNull();
    expect(parseChartSpec('type: line\nx: year')).toBeNull();
    expect(parseChartSpec('[1, 2, 3]')).toBeNull();
    expect(parseChartSpec('{ "type": "line", ')).toBeNull();
  });
});

describe('toChartNumber', () => {
  it('accepts numbers and numeric strings, rejects everything else', () => {
    expect(toChartNumber(42)).toBe(42);
    expect(toChartNumber('42')).toBe(42);
    expect(toChartNumber(' 1,234.5 ')).toBe(1234.5);
    expect(toChartNumber('-3.2%')).toBe(-3.2);
    expect(toChartNumber('')).toBeNull();
    expect(toChartNumber('n/a')).toBeNull();
    expect(toChartNumber(null)).toBeNull();
    expect(toChartNumber(Number.NaN)).toBeNull();
    expect(toChartNumber({ value: 1 })).toBeNull();
  });
});
