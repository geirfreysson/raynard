import { describe, expect, it } from 'vitest';
import type { ChartSpec } from './chart-spec';
import { extractPresentedChart, normalizeStoredCharts, planChartPlacement } from './presented-chart';

const chart: ChartSpec = {
  type: 'bar',
  x: 'event',
  series: [{ key: 'probability', label: 'Probability' }],
  rows: [{ event: 'Iceland referendum', probability: 54 }]
};

const chartB: ChartSpec = {
  type: 'line',
  x: 'year',
  series: [{ key: 'value', label: 'Value' }],
  rows: [{ year: 2020, value: 1 }]
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

describe('planChartPlacement', () => {
  it('anchors a chart at the next line break after its recorded offset', () => {
    const text = 'Intro sentence.\nMore detail here.\nConclusion.';
    const offset = text.indexOf('More'); // mid-line, inside the second line
    const { anchored, trailing } = planChartPlacement(text, [chart], [offset]);
    expect(trailing).toEqual([]);
    expect(anchored).toEqual([{ spec: chart, offset: text.indexOf('Conclusion.') }]);
  });

  it('falls back to trailing when a chart has no recorded offset', () => {
    const text = 'Some answer text.';
    const { anchored, trailing } = planChartPlacement(text, [chart], undefined);
    expect(anchored).toEqual([]);
    expect(trailing).toEqual([chart]);
  });

  it('falls back to trailing when the offset is at or past the end of the text', () => {
    const text = 'Short.';
    const { anchored, trailing } = planChartPlacement(text, [chart, chartB], [
      text.length,
      text.length + 5
    ]);
    expect(anchored).toEqual([]);
    expect(trailing).toEqual([chart, chartB]);
  });

  it('falls back to trailing for a negative offset', () => {
    const text = 'Some answer text.';
    const { anchored, trailing } = planChartPlacement(text, [chart], [-1]);
    expect(anchored).toEqual([]);
    expect(trailing).toEqual([chart]);
  });

  it('snaps to the end of the text when the offset has no following line break', () => {
    const text = 'One line, no trailing newline';
    const { anchored } = planChartPlacement(text, [chart], [5]);
    expect(anchored).toEqual([{ spec: chart, offset: text.length }]);
  });

  it('sorts multiple anchored charts by resolved offset regardless of input order', () => {
    const text = 'First.\nSecond.\nThird.\n';
    const secondOffset = text.indexOf('Second');
    const firstOffset = text.indexOf('First');
    const { anchored, trailing } = planChartPlacement(
      text,
      [chartB, chart],
      [secondOffset, firstOffset]
    );
    expect(trailing).toEqual([]);
    expect(anchored.map((entry) => entry.spec)).toEqual([chart, chartB]);
    expect(anchored[0].offset).toBeLessThan(anchored[1].offset);
  });
});
