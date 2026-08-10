// Shared runtime for generated API plugins. The host installs this package
// once above all plugin workspaces; plugin authors import it by package name.

import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_ENTRY_VERSION = 1;
const HOUR_MS = 60 * 60 * 1000;
// Values shorter than this are too likely to collide with ordinary words for
// blind substring redaction to be safe.
const REDACTABLE_SECRET_LENGTH = 8;
let apiCacheConfig = { enabled: false, ttlHours: 24, directory: '' };
// Supplied by the host at execution time and never written to disk. The
// runner configures this before importing the plugin module.
let credentialValues = new Map();

/**
 * Thrown when a plugin asks for a credential the host has not configured. The
 * runner recognizes this by name and turns it into a structured request the
 * app can answer with a prompt, instead of a bare tool failure.
 */
export class MissingCredentialError extends Error {
  constructor(key, label) {
    super(`Missing credential ${key}. Add it in the plugin's settings to use this tool.`);
    this.name = 'MissingCredentialError';
    this.credentialKey = key;
    this.credentialLabel = label || key;
  }
}

export function configureCredentials(values = {}) {
  const next = new Map();
  for (const [key, value] of Object.entries(values || {})) {
    const name = String(key || '').trim();
    const secret = typeof value === 'string' ? value.trim() : '';
    if (name && secret) next.set(name, secret);
  }
  credentialValues = next;
}

export function getCredential(key) {
  return credentialValues.get(String(key || '').trim()) || '';
}

export function requireCredential(key, label) {
  const name = String(key || '').trim();
  const value = credentialValues.get(name);
  if (!value) throw new MissingCredentialError(name, label);
  return value;
}

/**
 * Replaces every configured credential value with a placeholder. Error text
 * from a plugin reaches the language model, the provider, and the on-disk turn
 * log, and APIs that take their key as a query parameter put it straight into
 * the request URL — so every error path has to pass through here.
 */
export function redactSecrets(text) {
  let output = String(text ?? '');
  for (const value of credentialValues.values()) {
    if (value.length < REDACTABLE_SECRET_LENGTH) continue;
    output = output.split(value).join('***');
  }
  return output;
}

export function configureApiCache(options = {}) {
  const ttlHours = Number(options.ttlHours ?? 24);
  apiCacheConfig = {
    enabled: options.enabled === true,
    ttlHours: Number.isInteger(ttlHours) && ttlHours >= 1 && ttlHours <= 8760 ? ttlHours : 24,
    directory: typeof options.directory === 'string' ? options.directory.trim() : ''
  };
}

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
  const cachePath = apiCacheEntryPath(target, options.headers);
  if (cachePath) {
    const cached = await readApiCacheEntry(cachePath);
    if (cached.hit) return cached.payload;
  }
  const response = await fetch(target, { headers: options.headers });
  if (!response.ok) {
    // The target carries the query string, so an API that authenticates with
    // ?apikey= would otherwise leak the key into the model's context.
    throw new Error(
      redactSecrets(
        `${label} request failed with HTTP ${response.status} for ${target}${await errorDetail(response)}`
      )
    );
  }
  const payload = await response.json();
  if (cachePath) await writeApiCacheEntry(cachePath, payload);
  return payload;
}

function apiCacheEntryPath(target, headers = {}) {
  if (!apiCacheConfig.enabled || !apiCacheConfig.directory) return '';
  const normalizedHeaders = Object.entries(headers || {})
    .map(([name, value]) => [name.toLowerCase(), String(value)])
    .sort(([left], [right]) => left.localeCompare(right));
  const signature = JSON.stringify({ method: 'GET', target, headers: normalizedHeaders });
  const key = createHash('sha256').update(signature).digest('hex');
  return join(apiCacheConfig.directory, `${key}.json`);
}

async function readApiCacheEntry(path) {
  try {
    const entry = JSON.parse(await readFile(path, 'utf8'));
    const valid =
      entry &&
      entry.version === CACHE_ENTRY_VERSION &&
      Number.isFinite(entry.storedAt) &&
      Object.prototype.hasOwnProperty.call(entry, 'payload');
    if (!valid || Date.now() - entry.storedAt >= apiCacheConfig.ttlHours * HOUR_MS) {
      await rm(path, { force: true }).catch(() => {});
      return { hit: false };
    }
    return { hit: true, payload: entry.payload };
  } catch {
    await rm(path, { force: true }).catch(() => {});
    return { hit: false };
  }
}

async function writeApiCacheEntry(path, payload) {
  const temporaryPath = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await mkdir(apiCacheConfig.directory, { recursive: true });
    await writeFile(
      temporaryPath,
      JSON.stringify({ version: CACHE_ENTRY_VERSION, storedAt: Date.now(), payload }),
      'utf8'
    );
    await rename(temporaryPath, path);
  } catch {
    // Cache failures must never turn a successful API request into a tool failure.
    await rm(temporaryPath, { force: true }).catch(() => {});
  }
}

async function errorDetail(response) {
  try {
    const body = await response.json();
    const message = body && typeof body === 'object' ? body.error ?? body.message : undefined;
    return typeof message === 'string' && message.trim() ? ` — ${redactSecrets(message.trim())}` : '';
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
