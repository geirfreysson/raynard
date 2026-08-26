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
