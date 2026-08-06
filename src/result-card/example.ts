import type { CardBlock, CardTemplate } from './types';

// Synthesize representative example `data` for a card template so the plugin
// detail view can preview a card's layout without calling the real API. Every
// field/path the template binds to is filled with a readable placeholder chosen
// by a light heuristic on the leaf key name.

function leafKey(path: string): string {
  const parts = String(path || '')
    .split('.')
    .filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(path || '');
}

function sampleValue(pathOrField: string, opts: { delta?: boolean; index?: number } = {}): string {
  const leaf = leafKey(pathOrField).toLowerCase();
  const i = opts.index ?? 0;
  if (opts.delta || /(change|delta|pct|percent|growth|trend|diff)/.test(leaf)) {
    return ['+3.2%', '-1.4%', '+0.8%'][i % 3];
  }
  if (/(price|cost|amount|value|balance|gold|gp|fee)/.test(leaf)) return (42.5 + i * 7).toFixed(2);
  if (/(count|total|num|qty|quantity|hp|hit|level|cr|ac|str|dex|con|int|wis|cha|score|rank|weight|range|speed|age)/.test(leaf)) {
    return String(10 + i * 3);
  }
  if (/(name|title|label|monster|spell|creature|item|equipment|author|user)/.test(leaf)) {
    return `Example ${leafKey(pathOrField)} ${i + 1}`.trim();
  }
  if (/(date|time|updated|created|published|fetched)/.test(leaf)) return '2026-01-01';
  if (/(url|link|source|href|uri)/.test(leaf)) return 'https://example.com';
  if (/(id|slug|key|index|ref)/.test(leaf)) return `example-${leafKey(pathOrField)}`;
  if (/(desc|description|summary|text|note|detail|flavor)/.test(leaf)) return `Sample ${leafKey(pathOrField)} text.`;
  if (/(type|category|kind|school|class|size|alignment|rarity|status)/.test(leaf)) return 'Sample';
  return `Sample ${leafKey(pathOrField)}`;
}

// Set a dotted path, creating intermediate objects. Does not overwrite an
// already-set leaf, so paths shared across blocks stay consistent.
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = String(path || '')
    .split('.')
    .filter(Boolean);
  if (!parts.length) return;
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    const next = node[key];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      node[key] = {};
    }
    node = node[key] as Record<string, unknown>;
  }
  const leaf = parts[parts.length - 1];
  if (node[leaf] === undefined) node[leaf] = value;
}

function interpolationPaths(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || '')))) out.push(match[1].trim());
  return out;
}

// A self-contained placeholder image (no network) for card previews.
const SAMPLE_IMAGE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'%3E%3Crect width='96' height='96' fill='%23e6e6ea'/%3E%3Cpath d='M18 70l18-22 13 15 11-13 18 20z' fill='%23b4b4bb'/%3E%3Ccircle cx='35' cy='33' r='9' fill='%23b4b4bb'/%3E%3C/svg%3E";

function fillBlock(block: CardBlock, data: Record<string, unknown>): void {
  switch (block.component) {
    case 'MetricRow':
      for (const item of block.items || []) {
        setPath(data, item.field, sampleValue(item.field, { delta: item.tone === 'delta' }));
      }
      break;
    case 'Table': {
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < 3; i++) {
        const row: Record<string, unknown> = {};
        for (const col of block.columns || []) setPath(row, col.field, sampleValue(col.field, { index: i }));
        rows.push(row);
      }
      setPath(data, block.rows, rows);
      break;
    }
    case 'KeyValue':
      for (const pair of block.pairs || []) setPath(data, pair.field, sampleValue(pair.field));
      break;
    case 'Text':
      for (const path of interpolationPaths(block.text)) setPath(data, path, sampleValue(path));
      break;
    case 'Section':
    case 'Stack':
    case 'Grid':
      for (const child of block.layout || []) fillBlock(child, data);
      break;
    case 'Columns':
      for (const column of block.columns || []) {
        for (const child of column.layout || []) fillBlock(child, data);
      }
      break;
    case 'Badge':
      setPath(data, block.field, sampleValue(block.field));
      break;
    case 'Image':
      setPath(data, block.field, SAMPLE_IMAGE);
      break;
    case 'Json':
      if (block.field) setPath(data, block.field, { sample: sampleValue(block.field) });
      break;
    default:
      break;
  }
}

/** Build placeholder data covering every path a card template binds to. */
export function buildExampleData(template: CardTemplate): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const path of interpolationPaths(template?.title || '')) setPath(data, path, sampleValue(path));
  for (const block of template?.layout || []) fillBlock(block, data);
  return data;
}
