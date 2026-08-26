import { describe, expect, it } from 'vitest';
import { extractPresentedChart, normalizeStoredCharts } from './presented-chart';

const chart = {
  type: 'bar',
  x: 'event',
  series: [{ key: 'probability', label: 'Probability' }],
  rows: [{ event: 'Iceland referendum', probability: 54 }]
};

describe('presented charts', () => {
  it('extracts a valid native chart tool result', () => {
    expect(extractPresentedChart({ type: 'presented-chart', chart })).toEqual(chart);
  });

  it('rejects unrelated and structurally incomplete tool results', () => {
    expect(extractPresentedChart({ type: 'plugin-result', chart })).toBeNull();
    expect(
      extractPresentedChart({
        type: 'presented-chart',
        chart: { type: 'bar', x: 'event', rows: chart.rows }
      })
    ).toBeNull();
  });

  it('revalidates charts loaded from persistence and drops malformed entries', () => {
    expect(normalizeStoredCharts([chart, { type: 'bar', x: 'event', rows: [] }])).toEqual([
      chart
    ]);
  });
});
