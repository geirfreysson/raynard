// Parser for the ```chart markdown fence the main agent emits instead of a
// markdown table. Pure and DOM-free so it can be tested directly; the renderer
// (src/components/ui/chart.tsx) receives an already-validated spec.
//
// Every rejection path returns null so the caller can fall back to rendering the
// fence as an ordinary code block. A malformed spec must never blank out the
// model's output.

export type ChartKind = 'line' | 'bar';
export type ChartAxis = 'left' | 'right';

export type ChartSeries = {
  key: string;
  label: string;
  /** Omitted means the primary, left-hand Y axis. */
  axis?: ChartAxis;
};

export type ChartRow = Record<string, string | number | null>;

export type ChartSpec = {
  type: ChartKind;
  title?: string;
  x: string;
  xLabel?: string;
  yLabel?: string;
  rightYLabel?: string;
  stacked?: boolean;
  /** Series or category names the answer is about; the rest are drawn muted. */
  highlight?: string[];
  /**
   * Citation numbers whose observations were plotted. Only the model knows
   * which of a turn's calls actually fed the rows — a turn spends most of its
   * calls finding the data — so it names them here and the host cites those.
   */
  sources?: number[];
  series: ChartSeries[];
  rows: ChartRow[];
};

export const MAX_CHART_SERIES = 8;
export const MAX_CHART_ROWS = 200;
export const MAX_CHART_HIGHLIGHTS = 8;
export const MAX_CHART_SOURCES = 8;

function optionalText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Coerce a cell to a number for plotting. Models routinely emit numbers as
 * strings, sometimes with thousands separators or a trailing unit. Anything that
 * does not cleanly read as a number becomes null so the chart draws a gap rather
 * than an invented point.
 */
export function toChartNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.trim().replace(/,/g, '').replace(/%$/, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSeries(value: unknown): ChartSeries[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const series: ChartSeries[] = [];
  const seen = new Set<string>();

  for (const entry of value.slice(0, MAX_CHART_SERIES)) {
    if (!entry || typeof entry !== 'object') return null;
    const record = entry as Record<string, unknown>;
    const key = optionalText(record.key);
    if (!key || seen.has(key)) return null;
    const axis = optionalText(record.axis);
    if (axis && axis !== 'left' && axis !== 'right') return null;
    seen.add(key);
    series.push({
      key,
      label: optionalText(record.label) ?? key,
      ...(axis === 'right' ? { axis } : {})
    });
  }

  return series.length ? series : null;
}

/**
 * Build plottable rows: the x value is kept as-is for the axis label, and each
 * declared series key is coerced to a number. Returns null when no series key
 * resolves to a number anywhere, which means the model mislabeled its keys — an
 * empty chart is worse than showing the JSON.
 */
function parseRows(value: unknown, x: string, series: ChartSeries[]): ChartRow[] | null {
  if (!Array.isArray(value) || !value.length) return null;
  const rows: ChartRow[] = [];
  let plottable = 0;

  for (const entry of value.slice(0, MAX_CHART_ROWS)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const record = entry as Record<string, unknown>;
    const raw = record[x];
    const row: ChartRow = {
      [x]: typeof raw === 'number' ? raw : optionalText(raw) ?? ''
    };
    for (const { key } of series) {
      if (key === x) continue;
      const numeric = toChartNumber(record[key]);
      row[key] = numeric;
      if (numeric !== null) plottable += 1;
    }
    rows.push(row);
  }

  if (!plottable) return null;
  return rows;
}

/**
 * Collect highlight tokens, dropping anything unusable. Never fails the spec: a
 * malformed highlight must not throw away an otherwise good chart.
 */
function parseHighlight(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tokens: string[] = [];
  const seen = new Set<string>();

  for (const entry of value) {
    const token = optionalText(entry);
    if (!token) continue;
    const fingerprint = token.toLowerCase();
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    tokens.push(token);
    if (tokens.length >= MAX_CHART_HIGHLIGHTS) break;
  }

  return tokens.length ? tokens : undefined;
}

/**
 * Collect the citation numbers backing the plotted rows. Never fails the spec:
 * a malformed source list costs the chart its citation, not its chart.
 */
function parseSources(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const numbers: number[] = [];

  for (const entry of value) {
    const parsed = typeof entry === 'number' ? entry : Number(String(entry).replace(/[[\]^]/g, ''));
    if (!Number.isInteger(parsed) || parsed <= 0 || numbers.includes(parsed)) continue;
    numbers.push(parsed);
    if (numbers.length >= MAX_CHART_SOURCES) break;
  }

  return numbers.length ? numbers : undefined;
}

/** Parse a ```chart fence body. Returns null for anything malformed. */
export function parseChartSpec(source: string): ChartSpec | null {
  const text = String(source || '').trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const type = optionalText(record.type);
  if (type !== 'line' && type !== 'bar') return null;

  const x = optionalText(record.x);
  if (!x) return null;

  const series = parseSeries(record.series);
  if (!series) return null;
  const hasRightAxis = series.some((entry) => entry.axis === 'right');
  const hasLeftAxis = series.some((entry) => entry.axis !== 'right');
  // A secondary axis only makes sense alongside a primary one. Mixed-axis
  // stacks are also visually ambiguous because their totals use two units.
  if (hasRightAxis && (!hasLeftAxis || (type === 'bar' && record.stacked === true))) return null;

  const rows = parseRows(record.rows, x, series);
  if (!rows) return null;

  return {
    type,
    title: optionalText(record.title),
    x,
    xLabel: optionalText(record.xLabel),
    yLabel: optionalText(record.yLabel),
    rightYLabel: hasRightAxis ? optionalText(record.rightYLabel) : undefined,
    stacked: type === 'bar' && record.stacked === true ? true : undefined,
    highlight: parseHighlight(record.highlight),
    sources: parseSources(record.sources),
    series,
    rows
  };
}
