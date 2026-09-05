import { parseChartSpec, type ChartSpec } from './chart-spec';

/**
 * Read the structured details returned by the native present_chart agent tool.
 * The sidecar validates first, but stream payloads and share links are still
 * untrusted input at the renderer boundary, so validate with the host parser too.
 */
export function extractPresentedChart(result: unknown): ChartSpec | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (record.type !== 'presented-chart') return null;
  try {
    return parseChartSpec(JSON.stringify(record.chart));
  } catch {
    return null;
  }
}

/** Keep only valid structured charts loaded from chat history or a share link. */
export function normalizeStoredCharts(charts: unknown): ChartSpec[] {
  if (!Array.isArray(charts)) return [];
  const normalized: ChartSpec[] = [];
  for (const chart of charts) {
    try {
      const parsed = parseChartSpec(JSON.stringify(chart));
      if (parsed) normalized.push(parsed);
    } catch {}
  }
  return normalized;
}

export type ChartPlacement = { spec: ChartSpec; offset: number };

/**
 * Split a message's present_chart results into ones anchored to a position in
 * its text — where the model had written to when it called present_chart for
 * that chart — and ones that must render after everything else. A chart falls
 * back to "trailing" when it has no recorded offset (a message saved before
 * `chartOffsets` existed) or when the offset is at or past the end of the
 * current text (e.g. still streaming past it).
 *
 * An anchor snaps forward to the next line break so a chart never lands
 * mid-sentence, mid-list-item, or mid-table-row that the model was still
 * writing when it called the tool. Anchored entries come back sorted by
 * offset, in the order they should be inserted into the text.
 */
export function planChartPlacement(
  text: string,
  charts: ChartSpec[],
  chartOffsets: number[] | undefined
): { anchored: ChartPlacement[]; trailing: ChartSpec[] } {
  const anchored: ChartPlacement[] = [];
  const trailing: ChartSpec[] = [];

  charts.forEach((spec, index) => {
    const raw = chartOffsets?.[index];
    if (typeof raw !== 'number' || raw < 0 || raw >= text.length) {
      trailing.push(spec);
      return;
    }
    const lineBreak = text.indexOf('\n', raw);
    anchored.push({ spec, offset: lineBreak === -1 ? text.length : lineBreak + 1 });
  });

  anchored.sort((a, b) => a.offset - b.offset);
  return { anchored, trailing };
}
