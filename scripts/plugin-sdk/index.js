// Shared runtime for generated API plugins. The host installs this package
// once above all plugin workspaces; plugin authors import it by package name.

export function createApiReference(input) {
  return {
    referenceId: input.id,
    referenceLabel: input.label,
    referenceMeta: {
      sourceUrl: input.sourceUrl,
      fetchedAt: input.fetchedAt || new Date().toISOString(),
      payloadPath: input.payloadPath || ''
    },
    modalTitle: input.label,
    modalHint: input.sourceUrl,
    compactContent: [
      { type: 'header', state: 'complete', icon: 'check', title: input.label },
      { type: 'text', text: input.quote }
    ],
    expandedContent: [
      { type: 'header', state: 'complete', icon: 'check', title: input.label },
      { type: 'text', text: input.quote },
      { type: 'json', title: 'Raw API payload', text: JSON.stringify(input.payload ?? {}, null, 2) }
    ]
  };
}

export function defineCard(template) {
  assertCardTemplate(template);
  return template;
}

export function defineTools(tools) {
  assertToolRegistry(tools);
  return tools;
}

const CARD_COMPONENTS = new Set([
  'MetricRow',
  'Table',
  'KeyValue',
  'Text',
  'Section',
  'Stack',
  'Grid',
  'Columns',
  'Badge',
  'Image',
  'Json'
]);

function assertCardBlocks(blocks, path) {
  if (!Array.isArray(blocks) || blocks.length === 0) {
    throw new Error(`${path} must contain at least one card block.`);
  }
  blocks.forEach((block, index) => {
    const blockPath = `${path}[${index}]`;
    if (!block || typeof block !== 'object' || !CARD_COMPONENTS.has(block.component)) {
      throw new Error(`${blockPath} has an unsupported card component.`);
    }
    if (['Section', 'Stack', 'Grid'].includes(block.component)) {
      assertCardBlocks(block.layout, `${blockPath}.layout`);
    }
    if (block.component === 'Columns') {
      if (!Array.isArray(block.columns) || block.columns.length === 0) {
        throw new Error(`${blockPath}.columns must contain at least one column.`);
      }
      block.columns.forEach((column, columnIndex) => {
        assertCardBlocks(column?.layout, `${blockPath}.columns[${columnIndex}].layout`);
      });
    }
  });
}

export function assertCardTemplate(template) {
  const singular = template?.name?.singular;
  const plural = template?.name?.plural;
  if (typeof singular !== 'string' || !singular.trim() || typeof plural !== 'string' || !plural.trim()) {
    throw new Error('Card name must include non-empty singular and plural labels.');
  }
  assertCardBlocks(template.layout, 'card.layout');
  return template;
}

export function assertToolRegistry(tools) {
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) {
    throw new Error('tools.ts must export a tool registry object named tools.');
  }
  for (const [name, tool] of Object.entries(tools)) {
    if (!name.trim() || !tool || typeof tool !== 'object') {
      throw new Error('Every tool registry entry must have a non-empty name and definition.');
    }
    if (typeof tool.description !== 'string' || !tool.description.trim()) {
      throw new Error(`${name} must include a routing description.`);
    }
    if (!tool.parameters || typeof tool.parameters !== 'object' || tool.parameters.type !== 'object') {
      throw new Error(`${name} must include an object JSON parameter schema.`);
    }
    assertCardTemplate(tool.card);
    if (typeof tool.execute !== 'function') {
      throw new Error(`${name} must define execute(args).`);
    }
  }
  return tools;
}

export function assertToolResult(result) {
  if (!result || typeof result.text !== 'string' || !result.text.trim()) {
    throw new Error('Tool result must include non-empty text.');
  }
  if (!Array.isArray(result.references) || result.references.length === 0) {
    throw new Error('Tool result must include at least one API reference.');
  }
  if (!result.data || typeof result.data !== 'object' || Array.isArray(result.data)) {
    throw new Error('Tool result must include card data as an object.');
  }
  return result;
}

export function buildQuery(params = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export async function apiGet(url, options = {}) {
  const target = url + buildQuery(options.query);
  const label = options.label || safeHost(target);
  const response = await fetch(target, { headers: options.headers });
  if (!response.ok) {
    throw new Error(
      `${label} request failed with HTTP ${response.status} for ${target}${await errorDetail(response)}`
    );
  }
  return await response.json();
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    const message = body && typeof body === 'object' ? body.error ?? body.message : undefined;
    return typeof message === 'string' && message.trim() ? ` — ${message.trim()}` : '';
  } catch {
    return '';
  }
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return 'API';
  }
}

export function requireNonEmpty(value, label) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) throw new Error(`${label} must be a non-empty string.`);
  return trimmed;
}

export function requirePositiveInt(value, label) {
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`${label} must be a positive integer, received: ${String(value)}`);
  }
  return numeric;
}
