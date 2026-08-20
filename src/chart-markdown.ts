import { parseChartSpec } from './chart-spec';

// A narrow compatibility repair for answers saved before terminal `done.text`
// became authoritative. Only a complete fence containing a valid chart spec is
// moved onto block boundaries; ordinary mentions of ```chart remain untouched.
const COMPLETE_CHART_FENCE = /```chart[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export function normalizeChartFenceBoundaries(source: string): string {
  const text = String(source || '');
  let cursor = 0;
  let normalized = '';

  for (const match of text.matchAll(COMPLETE_CHART_FENCE)) {
    const index = match.index;
    if (index === undefined || !parseChartSpec(match[1])) continue;

    normalized += text.slice(cursor, index);
    const previous = index > 0 ? text[index - 1] : '';
    if (previous && previous !== '\n' && previous !== '\r') normalized += '\n\n';
    normalized += match[0];

    const end = index + match[0].length;
    const next = text[end] ?? '';
    if (next && next !== '\n' && next !== '\r') normalized += '\n\n';
    cursor = end;
  }

  return cursor ? normalized + text.slice(cursor) : text;
}
