import type { CardBlock, CardTemplate } from './types';

// The single place that knows which parts of a card template read `data`.
//
// Two callers depend on it: `buildExampleData` fills every bound path with a
// placeholder so a card can be previewed without an API call, and share-link
// projection keeps exactly these paths and drops everything else. Keeping one
// walker means a new `CardBlock` variant cannot be handled in one and forgotten
// in the other — the `never` assertion below turns that into a compile error.

/** How a bound path is consumed, so callers can synthesize a fitting placeholder. */
export type TemplateFieldKind = 'value' | 'delta' | 'image' | 'json';

/** One dotted path the template reads out of `data`. */
export type TemplateField = {
  path: string;
  kind: TemplateFieldKind;
};

/** One table block: where its rows live and which paths each row needs. */
export type TemplateTable = {
  /** Dotted path to the row array. */
  rows: string;
  /** Dotted paths read from within each row. */
  columns: string[];
  /**
   * True when a column binds an empty field, which `getPath` resolves to the
   * whole row. Such a row cannot be narrowed to named paths.
   */
  wholeRow: boolean;
};

/** Every path a card template binds into its `data`. */
export type TemplateFields = {
  fields: TemplateField[];
  tables: TemplateTable[];
  /**
   * True when a `Json` block has no `field`. That block renders the whole `data`
   * object, so nothing can be projected away without changing what is shown.
   */
  wholeData: boolean;
};

/** Extract every `{{path}}` token from a template string. */
export function interpolationPaths(text: string): string[] {
  const out: string[] = [];
  const re = /\{\{\s*([^}]+?)\s*\}\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(String(text || '')))) out.push(match[1].trim());
  return out;
}

/**
 * Report every path a card template reads.
 *
 * Note which strings are *not* interpolated by the renderer and so contribute no
 * paths: `Section.title`, `Table` column headers, `MetricRow` item labels, and
 * `KeyValue` pair labels are all rendered literally. `Image.alt` is the one
 * label that does interpolate.
 */
export function collectTemplateFields(template: CardTemplate): TemplateFields {
  const fields: TemplateField[] = [];
  const tables: TemplateTable[] = [];
  let wholeData = false;

  // First binding of a path wins, matching `setPath`'s no-overwrite rule.
  const addField = (path: string, kind: TemplateFieldKind) => {
    const trimmed = String(path || '').trim();
    if (!trimmed || fields.some((field) => field.path === trimmed)) return;
    fields.push({ path: trimmed, kind });
  };
  const addText = (text: string | undefined) => {
    for (const path of interpolationPaths(text || '')) addField(path, 'value');
  };

  const walk = (block: CardBlock): void => {
    switch (block.component) {
      case 'MetricRow':
        for (const item of block.items || []) {
          addField(item.field, item.tone === 'delta' ? 'delta' : 'value');
        }
        break;

      case 'Table': {
        const rows = String(block.rows || '').trim();
        if (!rows) break;
        const columns: string[] = [];
        let wholeRow = false;
        for (const column of block.columns || []) {
          const field = String(column.field || '').trim();
          if (!field) {
            wholeRow = true;
            continue;
          }
          if (!columns.includes(field)) columns.push(field);
        }
        tables.push({ rows, columns, wholeRow });
        break;
      }

      case 'KeyValue':
        for (const pair of block.pairs || []) addField(pair.field, 'value');
        break;

      case 'Text':
        addText(block.text);
        break;

      case 'Section':
      case 'Stack':
      case 'Grid':
        for (const child of block.layout || []) walk(child);
        break;

      case 'Columns':
        for (const column of block.columns || []) {
          for (const child of column.layout || []) walk(child);
        }
        break;

      case 'Badge':
        addField(block.field, 'value');
        break;

      case 'Image':
        addField(block.field, 'image');
        // `alt` is interpolated by the renderer and feeds the avatar fallback.
        addText(block.alt);
        break;

      case 'Json':
        if (block.field) addField(block.field, 'json');
        else wholeData = true;
        break;

      default: {
        // Adding a CardBlock variant without handling it here fails to compile.
        const exhaustive: never = block;
        void exhaustive;
        break;
      }
    }
  };

  addText(template?.title);
  for (const block of template?.layout || []) walk(block);

  return { fields, tables, wholeData };
}
