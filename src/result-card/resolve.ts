// Binding helpers: the ONLY place that reads values out of a tool call's `data`.
// Card components stay dumb and receive already-resolved strings/values.

/** Look up a dotted path (e.g. "quote.price", "holdings.0.symbol") in data. */
export function getPath(data: unknown, path: string): unknown {
  if (!path) return data;
  let current: unknown = data;
  for (const segment of path.split('.')) {
    if (current == null) return undefined;
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Render a value for display; objects/arrays fall back to compact JSON. */
export function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Replace {{path}} tokens in a template string with resolved data values. */
export function interpolate(template: string, data: unknown): string {
  if (!template) return '';
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, path: string) =>
    formatValue(getPath(data, path.trim()))
  );
}

/** Resolve a table's row array; returns [] when the path is missing/not an array. */
export function resolveRows(data: unknown, rowsPath: string): Record<string, unknown>[] {
  const rows = getPath(data, rowsPath);
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}
