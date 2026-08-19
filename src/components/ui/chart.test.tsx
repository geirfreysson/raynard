// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChartBlock } from './chart';
import { parseChartSpec } from '../../chart-spec';

// Recharts does all layout in effects and renders nothing under
// renderToStaticMarkup, so these run in jsdom rather than the SSR pattern the
// other component tests use. ResponsiveContainer sizes itself from the DOM,
// which jsdom reports as 0, so element dimensions are stubbed below.

const WIDTH = 640;
const HEIGHT = 260;

// Size only the chart container. Sizing every element instead would let the
// legend claim the full height and collapse the plot area to nothing.
function isChartContainer(element: Element): boolean {
  return (
    element.classList?.contains('recharts-responsive-container') ||
    element.classList?.contains('recharts-wrapper')
  );
}

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get(this: HTMLElement) {
      return isChartContainer(this) ? WIDTH : 0;
    }
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return isChartContainer(this) ? HEIGHT : 0;
    }
  });
  HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
    const width = isChartContainer(this) ? WIDTH : 0;
    const height = isChartContainer(this) ? HEIGHT : 0;
    return { width, height, top: 0, left: 0, bottom: height, right: width, x: 0, y: 0, toJSON() {} };
  };
  // ResponsiveContainer waits on ResizeObserver, which jsdom does not implement;
  // report the stubbed size once on observe so the chart gets a viewport.
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width: WIDTH, height: HEIGHT } } as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    }
    unobserve() {}
    disconnect() {}
  };
});

const productivity = JSON.stringify({
  type: 'line',
  title: 'GDP per person employed',
  x: 'year',
  series: [{ key: 'UK' }, { key: 'Germany', label: 'Germany' }],
  rows: [
    { year: 2010, UK: 100308, Germany: 115039 },
    { year: 2019, UK: 106180, Germany: 122617 },
    { year: 2023, UK: 107289, Germany: 123751 }
  ]
});

/** Rendered axis tick labels, wherever Recharts chose to put the text layer. */
function tickLabels(container: HTMLElement): string[] {
  return [...container.querySelectorAll('text')].map((node) => node.textContent?.trim() ?? '');
}

function axisText(container: HTMLElement): string {
  return tickLabels(container).join(' ');
}

/** Fill of each drawn bar. Recharts renders bar shapes as paths, not rects. */
function barFills(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('.recharts-bar-rectangle .recharts-rectangle')].map((node) =>
    node.getAttribute('fill')
  );
}

function curveYSpread(curve: Element): number {
  const numbers = (curve.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const yCoordinates = numbers.filter((_, index) => index % 2 === 1);
  return yCoordinates.length ? Math.max(...yCoordinates) - Math.min(...yCoordinates) : 0;
}

// ResponsiveContainer picks up its size in an effect, so the tree needs a flush
// after render before the plotted series exist.
async function mount(source: string): Promise<{ container: HTMLElement; root: Root }> {
  const spec = parseChartSpec(source);
  if (!spec) throw new Error('expected a valid chart spec');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(createElement(ChartBlock, { spec }));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
  return { container, root };
}

describe('ChartBlock', () => {
  it('draws one line per series with the title and axis values', async () => {
    const { container, root } = await mount(productivity);

    expect(container.querySelectorAll('.recharts-line-curve')).toHaveLength(2);
    expect(container.textContent).toContain('GDP per person employed');
    expect(container.innerHTML).toContain('--chart-1');
    expect(container.innerHTML).toContain('--chart-2');
    // Axis ticks come from the real data, not placeholders.
    expect(container.textContent).toContain('2010');
    expect(container.textContent).toContain('2023');

    act(() => root.unmount());
  });

  it('uses independent scales for dollar and percentage series', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'line',
        title: 'Iceland: GDP vs. export concentration',
        x: 'year',
        yLabel: 'International $',
        rightYLabel: '% of exports',
        series: [
          { key: 'gdp', label: 'GDP per capita' },
          { key: 'metals', label: 'Ores & metals exports', axis: 'right' },
          { key: 'food', label: 'Food exports', axis: 'right' }
        ],
        rows: [
          { year: 2005, gdp: 57512, metals: 19, food: 58.5 },
          { year: 2010, gdp: 56212, metals: 42, food: 41.4 },
          { year: 2020, gdp: 59544, metals: 36.1, food: 50.8 },
          { year: 2024, gdp: 67310, metals: 34.3, food: 44 }
        ]
      })
    );

    expect(container.querySelectorAll('.recharts-yAxis')).toHaveLength(2);
    expect(container.textContent).toContain('International $');
    expect(container.textContent).toContain('% of exports');
    const yLabels = [...container.querySelectorAll('.recharts-label')];
    // A rotated label must be centred on the axis midpoint. Recharts' default
    // inside-edge anchors make the text grow upward from the midpoint, which
    // sends longer labels above the chart viewport.
    expect(yLabels.map((label) => label.getAttribute('text-anchor'))).toEqual([
      'middle',
      'middle'
    ]);
    expect(axisText(container)).toMatch(/\d{2}K\b/);

    const curves = [...container.querySelectorAll('.recharts-line-curve')];
    expect(curves).toHaveLength(3);
    expect(curveYSpread(curves[1])).toBeGreaterThan(20);
    expect(curveYSpread(curves[2])).toBeGreaterThan(20);

    act(() => root.unmount());
  });

  it('draws bars for a bar spec', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'bar',
        x: 'country',
        series: [{ key: 'value' }],
        rows: [
          { country: 'UK', value: 12 },
          { country: 'Germany', value: 18 }
        ]
      })
    );

    expect(barFills(container)).toEqual([
      'hsl(var(--chart-1))',
      'hsl(var(--chart-1))'
    ]);
    expect(container.querySelectorAll('.recharts-line-curve')).toHaveLength(0);

    act(() => root.unmount());
  });

  it('uses a data-relative Y scale for lines but keeps a zero baseline for bars', async () => {
    const rows = [
      { year: 2021, value: 101 },
      { year: 2022, value: 104 },
      { year: 2023, value: 108 }
    ];
    const line = await mount(
      JSON.stringify({ type: 'line', x: 'year', series: [{ key: 'value' }], rows })
    );
    const bar = await mount(
      JSON.stringify({ type: 'bar', x: 'year', series: [{ key: 'value' }], rows })
    );

    const lineTicks = tickLabels(line.container);
    const barTicks = tickLabels(bar.container);
    expect(lineTicks).not.toContain('0');
    expect(lineTicks.some((tick) => Number(tick.replace(/,/g, '')) >= 100)).toBe(true);
    expect(barTicks).toContain('0');

    act(() => line.root.unmount());
    act(() => bar.root.unmount());
  });

  it('compacts large Y-axis ticks but keeps them exact in the data table', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'line',
        x: 'year',
        series: [{ key: 'gdp' }],
        rows: [
          { year: 2010, gdp: 1000000 },
          { year: 2019, gdp: 1250000 },
          { year: 2023, gdp: 1500000 }
        ]
      })
    );

    // Recharts 3 draws tick text in its own z-index layer rather than inside
    // the .recharts-yAxis group, so read the rendered text off the container.
    expect(axisText(container)).toMatch(/\dM\b/);
    expect(axisText(container)).not.toContain('1000000');

    // The exact figure survives in the disclosure.
    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('table')?.textContent).toContain('1,250,000');

    act(() => root.unmount());
  });

  it('does not round small values away on the Y axis', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'line',
        x: 'year',
        series: [{ key: 'rate' }],
        rows: [
          { year: 2010, rate: 0.045 },
          { year: 2019, rate: 0.03 },
          { year: 2023, rate: 0.021 }
        ]
      })
    );

    expect(axisText(container)).toMatch(/0\.0\d/);

    act(() => root.unmount());
  });

  it('rotates X labels only once they would collide', async () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ year: String(2000 + i), v: i }));
    const crowded = await mount(
      JSON.stringify({ type: 'line', x: 'year', series: [{ key: 'v' }], rows: many })
    );
    expect(crowded.container.innerHTML).toContain('rotate(-45');
    // Every year is labelled rather than every other one.
    const years = tickLabels(crowded.container).filter((label) => /^20\d\d$/.test(label));
    expect(years).toHaveLength(20);
    expect(years).toContain('2000');
    expect(years).toContain('2019');
    act(() => crowded.root.unmount());

    const sparse = await mount(productivity);
    expect(sparse.container.innerHTML).not.toContain('rotate(-45');
    act(() => sparse.root.unmount());
  });

  it('keeps every series colored while emphasizing the highlighted line', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'line',
        x: 'year',
        highlight: ['United Kingdom'],
        series: [{ key: 'UK', label: 'United Kingdom' }, { key: 'Germany' }, { key: 'France' }],
        rows: [
          { year: 2010, UK: 1, Germany: 2, France: 3 },
          { year: 2019, UK: 4, Germany: 5, France: 6 }
        ]
      })
    );

    const lines = [...container.querySelectorAll('.recharts-line-curve')];
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => line.getAttribute('stroke'))).toEqual([
      'hsl(var(--chart-1))',
      'hsl(var(--chart-2))',
      'hsl(var(--chart-3))'
    ]);
    expect(lines.map((line) => line.getAttribute('stroke-width'))).toEqual(['4', '2', '2']);
    expect(lines.map((line) => line.getAttribute('stroke-opacity'))).toEqual(['1', '0.65', '0.65']);

    act(() => root.unmount());
  });

  it('leaves the chart untouched when the highlight matches nothing', async () => {
    // Guards the regression where "no match" would mute every series at once.
    const { container, root } = await mount(
      JSON.stringify({
        type: 'line',
        x: 'year',
        highlight: ['Atlantis'],
        series: [{ key: 'UK' }, { key: 'Germany' }],
        rows: [
          { year: 2010, UK: 1, Germany: 2 },
          { year: 2019, UK: 4, Germany: 5 }
        ]
      })
    );

    const strokes = [...container.querySelectorAll('.recharts-line-curve')].map((node) =>
      node.getAttribute('stroke')
    );
    expect(strokes).toHaveLength(2);
    // Both keep a palette color. (The axis itself legitimately uses
    // --muted-foreground, so only the series strokes can be asserted on.)
    expect(strokes.every((stroke) => stroke?.includes('--chart-'))).toBe(true);

    act(() => root.unmount());
  });

  it('highlights a single bar when the token names a category', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'bar',
        x: 'country',
        highlight: ['United Kingdom'],
        series: [{ key: 'gdp' }],
        rows: [
          { country: 'United Kingdom', gdp: 107289 },
          { country: 'Germany', gdp: 123751 },
          { country: 'France', gdp: 125877 }
        ]
      })
    );

    const fills = barFills(container);
    expect(fills).toHaveLength(3);
    expect(fills.filter((fill) => fill?.includes('--chart-'))).toHaveLength(1);
    expect(fills.filter((fill) => fill?.includes('--muted-foreground'))).toHaveLength(2);

    act(() => root.unmount());
  });

  it('carries the highlight into the Show data table', async () => {
    const { container, root } = await mount(
      JSON.stringify({
        type: 'line',
        x: 'year',
        highlight: ['United Kingdom'],
        series: [{ key: 'UK', label: 'United Kingdom' }, { key: 'Germany' }],
        rows: [{ year: 2010, UK: 100308, Germany: 115039 }]
      })
    );

    act(() => {
      container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const headers = [...container.querySelectorAll('th')];
    const uk = headers.find((cell) => cell.textContent === 'United Kingdom');
    const germany = headers.find((cell) => cell.textContent === 'Germany');
    expect(uk?.className).toContain('font-semibold');
    expect(germany?.className).toContain('text-muted-foreground');

    act(() => root.unmount());
  });

  it('keeps the numbers behind the Show data disclosure', async () => {
    const { container, root } = await mount(productivity);
    const toggle = container.querySelector('button');

    expect(toggle?.textContent).toContain('Show data');
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('table')).toBeNull();

    act(() => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    // Series labels head the columns and values are formatted for reading.
    expect(table?.textContent).toContain('Germany');
    expect(table?.textContent).toContain('100,308');

    act(() => root.unmount());
  });
});
