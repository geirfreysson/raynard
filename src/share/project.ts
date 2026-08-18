import { resolveRows } from '../result-card/resolve';
import { collectTemplateFields } from '../result-card/template-fields';
import type { CardTemplate } from '../result-card/types';

// Narrow a card's `data` down to what its template actually reads.
//
// This is the single biggest lever for fitting a card into a URL, and it is safe
// for one specific reason: `src/result-card/resolve.ts` is the only interpreter
// of `data`, and it only ever resolves paths the template names. A field the
// template never binds cannot reach the screen, so dropping it changes nothing a
// recipient could see.
//
// Container types are mirrored from the source (array stays array, object stays
// object) so `getPath` and `resolveRows` resolve exactly as they did before.

type Container = Record<string, unknown> | unknown[];

function readKey(container: unknown, key: string): unknown {
  if (container == null) return undefined;
  if (Array.isArray(container)) {
    const index = Number(key);
    return Number.isInteger(index) ? container[index] : undefined;
  }
  if (typeof container === 'object') return (container as Record<string, unknown>)[key];
  return undefined;
}

function writeKey(container: Container, key: string, value: unknown): void {
  if (Array.isArray(container)) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0) container[index] = value;
    return;
  }
  (container as Record<string, unknown>)[key] = value;
}

function emptyLike(value: unknown): Container {
  return Array.isArray(value) ? [] : {};
}

/**
 * Walk `path`'s parent chain in both source and target, creating target
 * containers that mirror the source's shape. Returns the leaf key to write, or
 * null when the source has no such path.
 */
function ensureParent(
  source: unknown,
  target: Container,
  parts: string[]
): { parent: Container; leaf: string } | null {
  let src: unknown = source;
  let dst: Container = target;

  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const nextSrc = readKey(src, key);
    if (nextSrc === null || typeof nextSrc !== 'object') return null;

    let nextDst = readKey(dst, key);
    if (nextDst === null || typeof nextDst !== 'object') {
      nextDst = emptyLike(nextSrc);
      writeKey(dst, key, nextDst);
    }

    src = nextSrc;
    dst = nextDst as Container;
  }

  return { parent: dst, leaf: parts[parts.length - 1] };
}

function splitPath(path: string): string[] {
  return String(path || '')
    .split('.')
    .filter(Boolean);
}

/** Copy one dotted path from source into target, preserving container shapes. */
function copyPath(source: unknown, target: Container, path: string): void {
  const parts = splitPath(path);
  if (!parts.length) return;
  const slot = ensureParent(source, target, parts);
  if (!slot) return;
  const value = readKey(readParent(source, parts), slot.leaf);
  if (value !== undefined) writeKey(slot.parent, slot.leaf, value);
}

function readParent(source: unknown, parts: string[]): unknown {
  let current: unknown = source;
  for (let i = 0; i < parts.length - 1; i += 1) current = readKey(current, parts[i]);
  return current;
}

/** One table that lost rows to the budget. */
export type RowTruncation = { rows: string; shown: number; total: number };

export type ProjectedCardData = {
  data: unknown;
  truncated: RowTruncation[];
};

/**
 * Project one card's data.
 *
 * Returns null when the template contains a fieldless `Json` block: that block
 * renders the whole `data` object, so nothing can be dropped and nothing can be
 * row-capped without changing what is displayed.
 */
export function projectCardData(
  data: unknown,
  template: CardTemplate,
  options: { rowCap?: number } = {}
): ProjectedCardData | null {
  const { fields, tables, wholeData } = collectTemplateFields(template);
  if (wholeData) return null;

  const root = emptyLike(data);
  const truncated: RowTruncation[] = [];

  for (const field of fields) copyPath(data, root, field.path);

  for (const table of tables) {
    const rows = resolveRows(data, table.rows);
    const capped =
      options.rowCap !== undefined && rows.length > options.rowCap
        ? rows.slice(0, options.rowCap)
        : rows;
    if (capped.length < rows.length) {
      truncated.push({ rows: table.rows, shown: capped.length, total: rows.length });
    }

    // A column bound to an empty field renders the whole row, so those rows are
    // carried verbatim; row capping still applies.
    const projectedRows = table.wholeRow
      ? capped
      : capped.map((row) => {
          if (row === null || typeof row !== 'object') return row;
          const out = emptyLike(row);
          for (const column of table.columns) copyPath(row, out, column);
          return out;
        });

    const parts = splitPath(table.rows);
    if (!parts.length) continue;
    const slot = ensureParent(data, root, parts);
    if (slot) writeKey(slot.parent, slot.leaf, projectedRows);
  }

  return { data: root, truncated };
}
