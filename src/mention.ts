// "@" reference autocomplete: detect an @token being typed and offer the
// installed plugins, their tools, and their result cards so the user can drop an
// exact identifier into the message (which also avoids the agent guessing names).

export type MentionKind = 'plugin' | 'tool' | 'card';

export type MentionItem = {
  kind: MentionKind;
  /** Lower-case text the query is matched against. */
  match: string;
  /** Display label. */
  label: string;
  /** Secondary display line. */
  description: string;
  /** Text inserted into the textarea in place of the @query. */
  insertText: string;
};

export type ReferenceQuery = { query: string; replaceStart: number; replaceEnd: number };

// Minimal shape of a generated plugin as the app already holds it.
export type MentionPlugin = {
  id?: string;
  name?: string;
  directory?: string;
  tools?: Array<{
    name?: string;
    description?: string;
    card: { name: { singular: string; plural: string } };
  }>;
};

function isReferenceTokenChar(char: string): boolean {
  if (!char) return false;
  return /[a-zA-Z0-9._/-]/.test(char);
}

/**
 * If the cursor sits inside an `@token` (no whitespace since the `@`, and the
 * `@` starts a fresh word), return the query text and the range to replace.
 */
export function getReferenceQueryAtCursor(value: string, cursor: number): ReferenceQuery | null {
  const text = value || '';
  const safeCursor = typeof cursor === 'number' ? cursor : text.length;
  const beforeCursor = text.slice(0, safeCursor);
  const triggerIndex = beforeCursor.lastIndexOf('@');
  if (triggerIndex === -1) return null;

  const previousChar = triggerIndex > 0 ? beforeCursor.charAt(triggerIndex - 1) : '';
  if (previousChar && isReferenceTokenChar(previousChar)) return null;

  const between = beforeCursor.slice(triggerIndex + 1);
  for (const char of between) {
    if (!isReferenceTokenChar(char)) return null;
  }

  const afterCursor = text.slice(safeCursor);
  let trailing = '';
  for (const nextChar of afterCursor) {
    if (!isReferenceTokenChar(nextChar)) break;
    trailing += nextChar;
  }

  return { query: between, replaceStart: triggerIndex, replaceEnd: safeCursor + trailing.length };
}

function pluginSlug(plugin: MentionPlugin): string {
  const dir = String(plugin.directory || '');
  const base = dir.split('/').filter(Boolean).pop();
  if (base) return base;
  return String(plugin.id || '').replace(/^raynard\.generated\./, '');
}

/** Flatten installed plugins into plugin / tool / card reference items. */
export function buildMentionItems(plugins: MentionPlugin[]): MentionItem[] {
  const items: MentionItem[] = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    const slug = pluginSlug(plugin);
    const displayName = String(plugin.name || slug || '').trim();
    const tools = Array.isArray(plugin.tools) ? plugin.tools : [];
    if (slug) {
      items.push({
        kind: 'plugin',
        match: `${slug} ${displayName}`.toLowerCase(),
        label: displayName || slug,
        description: `plugin · ${slug} · ${tools.length} tool${tools.length === 1 ? '' : 's'}`,
        insertText: slug
      });
    }
    for (const tool of tools) {
      const toolName = String(tool?.name || '').trim();
      if (!toolName) continue;
      items.push({
        kind: 'tool',
        match: toolName.toLowerCase(),
        label: toolName,
        description: `tool · ${displayName || slug}`,
        insertText: toolName
      });
      const singular = tool.card.name.singular.trim();
      items.push({
        kind: 'card',
        match: `${singular} card ${toolName}`.toLowerCase(),
        label: `${singular} card`,
        description: `card · ${toolName}`,
        insertText: `${singular} card`
      });
    }
  }
  return items;
}

/** Rank items for a query: prefix matches first, then substring matches. */
export function filterMentionItems(items: MentionItem[], query: string, limit = 8): MentionItem[] {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return items.slice(0, limit);
  const scored: Array<{ item: MentionItem; score: number }> = [];
  for (const item of items) {
    const idx = item.match.indexOf(q);
    if (idx === -1) continue;
    // Prefix on the label/insertText ranks highest, then match-start, then anywhere.
    const startsLabel = item.label.toLowerCase().startsWith(q) || item.insertText.toLowerCase().startsWith(q);
    const score = startsLabel ? 0 : idx === 0 ? 1 : 2;
    scored.push({ item, score });
  }
  scored.sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}
