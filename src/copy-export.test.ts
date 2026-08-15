// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  chartSpecToMarkdown,
  inlineComputedSvgStyles,
  planSourceLines,
  truncateToWidth,
  wrapText
} from './copy-export';
import type { ChartSpec } from './chart-spec';

const spec: ChartSpec = {
  type: 'line',
  title: 'Revenue',
  x: 'quarter',
  xLabel: 'Quarter',
  series: [
    { key: 'revenue', label: 'Revenue ($m)' },
    { key: 'costs', label: 'Costs ($m)' }
  ],
  rows: [
    { quarter: 'Q1', revenue: 1200, costs: 800 },
    { quarter: 'Q2', revenue: 1450.5, costs: null }
  ]
};

describe('chartSpecToMarkdown', () => {
  it('renders the plotted rows as a markdown table', () => {
    expect(chartSpecToMarkdown(spec)).toBe(
      [
        '| Quarter | Revenue ($m) | Costs ($m) |',
        '| --- | --- | --- |',
        '| Q1 | 1,200 | 800 |',
        '| Q2 | 1,450.5 | — |'
      ].join('\n')
    );
  });

  it('falls back to the x key when no axis label was given', () => {
    const [header] = chartSpecToMarkdown({ ...spec, xLabel: undefined }).split('\n');
    expect(header).toBe('| quarter | Revenue ($m) | Costs ($m) |');
  });

  it('escapes pipes so a value cannot break the table', () => {
    const markdown = chartSpecToMarkdown({
      ...spec,
      rows: [{ quarter: 'a|b', revenue: 1, costs: 2 }]
    });
    expect(markdown).toContain('| a\\|b | 1 | 2 |');
  });
});

describe('inlineComputedSvgStyles', () => {
  it('copies computed paint onto the clone so var() colors survive serialization', () => {
    const container = document.createElement('div');
    container.innerHTML =
      '<svg><path style="fill: rgb(1, 2, 3); stroke-width: 2px" /><text style="font-size: 12px">A</text></svg>';
    document.body.appendChild(container);

    const clone = inlineComputedSvgStyles(container.querySelector('svg')!);
    const path = clone.querySelector('path')!;
    const text = clone.querySelector('text')!;

    expect(path.style.fill).toBe('rgb(1, 2, 3)');
    expect(path.style.strokeWidth).toBe('2px');
    expect(text.style.fontSize).toBe('12px');
    expect(clone.getAttribute('xmlns')).toBe('http://www.w3.org/2000/svg');
    // The live chart must be left untouched.
    expect(container.querySelector('path')!.getAttribute('style')).toBe(
      'fill: rgb(1, 2, 3); stroke-width: 2px'
    );

    container.remove();
  });
});

// One unit of width per character, which is enough to exercise the layout.
const context = { measureText: (text: string) => ({ width: text.length }) as TextMetrics };

describe('truncateToWidth', () => {
  it('leaves text that already fits', () => {
    expect(truncateToWidth(context, 'Source: OECD', 40)).toBe('Source: OECD');
  });

  it('ellipsizes rather than letting the citation run into the brand mark', () => {
    expect(truncateToWidth(context, 'Sources: OECD Data Explorer', 12)).toBe('Sources: OE…');
  });

  it('does not leave a space before the ellipsis', () => {
    expect(truncateToWidth(context, 'Sources: OECD', 9)).toBe('Sources:…');
  });
});

describe('planSourceLines', () => {
  it('names a single source on one line', () => {
    expect(planSourceLines(context, ['D&D 5e monster: Orc'], 100)).toEqual([
      'Source: D&D 5e monster: Orc'
    ]);
  });

  it('packs several names onto a line while they fit', () => {
    expect(planSourceLines(context, ['Orc', 'Goblin', 'Kobold'], 100)).toEqual([
      'Sources: Orc · Goblin · Kobold'
    ]);
  });

  it('wraps to a new line rather than truncating what still fits', () => {
    // The label only costs width on the first line, so later lines hold more.
    expect(planSourceLines(context, ['Orc', 'Goblin', 'Kobold'], 18)).toEqual([
      'Sources: Orc',
      'Goblin · Kobold'
    ]);
  });

  it('counts the names it could not fit in the lines available', () => {
    const lines = planSourceLines(context, ['Orc', 'Goblin', 'Kobold', 'Owlbear'], 18, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('+1 more');
  });

  it('truncates a name too long for the width', () => {
    const [line] = planSourceLines(context, ['A very long dataset name indeed'], 20);
    expect(line).toHaveLength(20);
    expect(line.endsWith('…')).toBe(true);
  });

  it('draws nothing when there is nothing to cite or no room', () => {
    expect(planSourceLines(context, [], 100)).toEqual([]);
    expect(planSourceLines(context, ['Orc'], 0)).toEqual([]);
  });
});

describe('wrapText', () => {

  it('wraps on words that no longer fit', () => {
    expect(wrapText(context, 'alpha beta gamma', 10)).toEqual(['alpha beta', 'gamma']);
  });

  it('keeps a line that fits intact', () => {
    expect(wrapText(context, 'alpha beta', 40)).toEqual(['alpha beta']);
  });

  it('returns nothing for an empty cell', () => {
    expect(wrapText(context, '   ', 40)).toEqual([]);
  });

  it('keeps an over-long word on its own line rather than looping', () => {
    expect(wrapText(context, 'a supercalifragilistic b', 5)).toEqual([
      'a',
      'supercalifragilistic',
      'b'
    ]);
  });
});
