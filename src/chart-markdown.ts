import { parseChartSpec } from './chart-spec';

// A narrow compatibility repair for answers saved before terminal `done.text`
// became authoritative, plus recovery for a model that emits a valid chart
// spec without labelling the fence ```chart (Kimi has been observed doing
// this). Any fence whose body parses as a chart spec is moved onto block
// boundaries regardless of its language tag; a fence that is not valid JSON
// chart data is left untouched.
const ANY_FENCE = /```[^\n`]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g;

export function normalizeChartFenceBoundaries(source: string): string {
  const text = String(source || '');
  let cursor = 0;
  let normalized = '';

  for (const match of text.matchAll(ANY_FENCE)) {
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
