// Presentation decisions for the ```chart renderer: axis formatting, tick
// crowding, and highlight resolution. Pure and DOM-free so the rules are
// testable directly; src/components/ui/chart.tsx only applies what these return.

import type { ChartRow, ChartSeries, ChartSpec } from './chart-spec';

/** Above this magnitude, axis ticks switch to compact notation (100.3K, 1M). */
const COMPACT_THRESHOLD = 10000;

// Rough metrics for the 12px axis font, used to guess whether X labels collide.
const CHAR_WIDTH = 6.5;
const TICK_GAP = 12;
/** Assumed plot width: a ~640px card minus the 64px Y axis and margins. */
const PLOT_WIDTH = 560;
/** Even rotated, more labels than this is a smear rather than an axis. */
const MAX_ANGLED_TICKS = 30;
const MAX_TICK_HEIGHT = 70;
/** Vertical extent of text rotated 45 degrees, per character. */
const ROTATED_CHAR_HEIGHT = CHAR_WIDTH * Math.SQRT1_2;

/** Largest absolute value across every plotted series. 0 when there is none. */
export function maxAbsValue(rows: ChartRow[], series: ChartSeries[]): number {
  let max = 0;
  for (const row of rows || []) {
    for (const { key } of series || []) {
      const value = row?.[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        max = Math.max(max, Math.abs(value));
      }
    }
  }
  return max;
}

/**
 * Decimal places for grouped notation, scaled to magnitude so small series keep
 * their precision: 0.045 must not round away to "0".
 */
function fractionDigitsFor(max: number): number {
  if (max < 1) return 3;
  if (max < 10) return 2;
  if (max < 100) return 1;
  return 0;
}

/**
 * Build one tick formatter for the whole axis, chosen from the data's largest
 * value. Compact notation is applied only when the numbers are big enough to
 * benefit — applying it unconditionally renders 0.045 as "0".
 */
export function createAxisFormatter(
  rows: ChartRow[],
  series: ChartSeries[]
): (value: unknown) => string {
  const max = maxAbsValue(rows, series);
  const format =
    max >= COMPACT_THRESHOLD
      ? new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
      : new Intl.NumberFormat('en', { maximumFractionDigits: fractionDigitsFor(max) });

  return (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    return format.format(value);
  };
}

/** Full-precision rendering for the tooltip and the Show data table. */
export function formatFullNumber(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value.toLocaleString('en', { maximumFractionDigits: 6 }) : '—';
  }
  return String(value);
}

export type XTickLayout = {
  /** Rotate labels 45 degrees to fit more of them. */
  angled: boolean;
  /** Recharts interval: show every (interval + 1)th tick. */
  interval: number;
  /** Vertical space to reserve for rotated labels; 0 when horizontal. */
  height: number;
};

/**
 * Decide whether X labels need rotating. The real plot width is not known until
 * ResponsiveContainer measures itself, so this estimates against a typical card
 * width — erring toward rotating, which stays readable either way.
 */
export function xTickLayout(rows: ChartRow[], xKey: string): XTickLayout {
  const labels = (rows || []).map((row) => String(row?.[xKey] ?? ''));
  const maxChars = labels.reduce((max, label) => Math.max(max, label.length), 0);
  if (!labels.length || !maxChars) {
    return { angled: false, interval: 0, height: 0 };
  }

  const fits = Math.max(1, Math.floor(PLOT_WIDTH / (maxChars * CHAR_WIDTH + TICK_GAP)));
  if (labels.length <= fits) {
    return { angled: false, interval: 0, height: 0 };
  }

  // Rotated labels still need thinning once there are very many of them.
  const interval = Math.max(0, Math.ceil(labels.length / MAX_ANGLED_TICKS) - 1);
  const height = Math.min(MAX_TICK_HEIGHT, Math.round(maxChars * ROTATED_CHAR_HEIGHT) + 16);
  return { angled: true, interval, height };
}

export type HighlightResolution = {
  /** Series keys to draw at full strength. */
  series: Set<string>;
  /** X-axis values to draw at full strength. */
  categories: Set<string>;
  /** False when nothing matched, so the renderer leaves the chart alone. */
  active: boolean;
};

/**
 * Resolve highlight tokens against the spec: a series key or label first, then
 * an x-axis value. Tokens matching neither are ignored rather than treated as
 * "highlight nothing", which would mute every series at once.
 */
export function resolveHighlight(spec: ChartSpec): HighlightResolution {
  const series = new Set<string>();
  const categories = new Set<string>();
  const tokens = spec?.highlight ?? [];

  if (tokens.length) {
    const byName = new Map<string, string>();
    for (const entry of spec.series || []) {
      byName.set(entry.key.toLowerCase(), entry.key);
      byName.set(entry.label.toLowerCase(), entry.key);
    }
    const byCategory = new Map<string, string>();
    for (const row of spec.rows || []) {
      const value = row?.[spec.x];
      if (value === null || value === undefined) continue;
      const text = String(value);
      if (text) byCategory.set(text.toLowerCase(), text);
    }

    for (const token of tokens) {
      const needle = token.trim().toLowerCase();
      const seriesKey = byName.get(needle);
      if (seriesKey) {
        series.add(seriesKey);
        continue;
      }
      const category = byCategory.get(needle);
      if (category) categories.add(category);
    }
  }

  return { series, categories, active: series.size > 0 || categories.size > 0 };
}
