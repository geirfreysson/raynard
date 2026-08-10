import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiGet,
  assertCardTemplate,
  assertToolRegistry,
  assertToolResult,
  configureApiCache,
  createApiReference,
  defineTools,
  requireNonEmpty,
  requirePositiveInt
} from './plugin-sdk/index.js';
import { expectToolResult, mockFetch } from './plugin-sdk/testing.js';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('shared generated-plugin SDK', () => {
  afterEach(() => {
    configureApiCache({ enabled: false });
    vi.restoreAllMocks();
  });

  it('defines tool registries without changing their runtime shape', () => {
    const tools = {
      lookup: {
        description: 'Looks up one example.',
        parameters: { type: 'object', properties: {} },
        card: {
          name: { singular: 'example', plural: 'examples' },
          layout: [{ component: 'Json' }]
        },
        execute: async () => ({ text: 'Example', references: [{}], data: {} })
      }
    };
    expect(defineTools(tools)).toBe(tools);
    expect(assertToolRegistry(tools)).toBe(tools);
  });

  it('rejects incomplete tools and unsupported card layouts', () => {
    expect(() => assertCardTemplate({ name: { singular: 'thing', plural: 'things' }, layout: [] }))
      .toThrow(/at least one card block/i);
    expect(() => assertToolRegistry({ lookup: { description: 'Lookup', parameters: { type: 'object' } } }))
      .toThrow(/singular and plural/i);
  });

  it('fetches JSON with encoded optional query values', async () => {
    const mocked = mockFetch((url) => ({ body: { url } }));
    try {
      const result = await apiGet('https://api.example.com/items', {
        query: { q: 'north fox', empty: undefined, limit: 5 }
      });
      expect(result).toEqual({ url: 'https://api.example.com/items?q=north+fox&limit=5' });
      expect(mocked.calls).toEqual(['https://api.example.com/items?q=north+fox&limit=5']);
    } finally {
      mocked.restore();
    }
  });

  it('caches identical successful API GETs until the configured TTL expires', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'raynard-sdk-cache-'));
    const mocked = mockFetch((url) => ({ body: { url, call: mocked.calls.length } }));
    try {
      configureApiCache({ enabled: true, ttlHours: 24, directory: cacheDir });
      const first = await apiGet('https://api.example.com/items', { query: { limit: 5 } });
      const second = await apiGet('https://api.example.com/items', { query: { limit: 5 } });

      expect(second).toEqual(first);
      expect(mocked.calls).toHaveLength(1);
      expect(await readdir(cacheDir)).toHaveLength(1);

      const [entryName] = await readdir(cacheDir);
      const entryPath = join(cacheDir, entryName);
      const entry = JSON.parse(await readFile(entryPath, 'utf8'));
      await writeFile(entryPath, JSON.stringify({ ...entry, storedAt: Date.now() - 2 * 60 * 60 * 1000 }));
      configureApiCache({ enabled: true, ttlHours: 1, directory: cacheDir });

      const refreshed = await apiGet('https://api.example.com/items', { query: { limit: 5 } });
      expect(refreshed).not.toEqual(first);
      expect(mocked.calls).toHaveLength(2);
    } finally {
      mocked.restore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('varies cache entries by final URL and normalized request headers', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'raynard-sdk-cache-'));
    const mocked = mockFetch((url) => ({ body: { url, call: mocked.calls.length } }));
    try {
      configureApiCache({ enabled: true, ttlHours: 24, directory: cacheDir });
      await apiGet('https://api.example.com/items', { query: { page: 1 }, headers: { Accept: 'application/json' } });
      await apiGet('https://api.example.com/items', { query: { page: 2 }, headers: { Accept: 'application/json' } });
      await apiGet('https://api.example.com/items', { query: { page: 1 }, headers: { Accept: 'application/problem+json' } });
      await apiGet('https://api.example.com/items', { query: { page: 1 }, headers: { accept: 'application/json' } });

      expect(mocked.calls).toHaveLength(3);
      expect(await readdir(cacheDir)).toHaveLength(3);
    } finally {
      mocked.restore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('bypasses caching when disabled and ignores malformed cache entries', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'raynard-sdk-cache-'));
    const mocked = mockFetch((url) => ({ body: { url, call: mocked.calls.length } }));
    try {
      configureApiCache({ enabled: false, ttlHours: 24, directory: cacheDir });
      await apiGet('https://api.example.com/live');
      await apiGet('https://api.example.com/live');
      expect(mocked.calls).toHaveLength(2);

      configureApiCache({ enabled: true, ttlHours: 24, directory: cacheDir });
      await apiGet('https://api.example.com/cached');
      const [entryName] = await readdir(cacheDir);
      await writeFile(join(cacheDir, entryName), '{not-json', 'utf8');
      await apiGet('https://api.example.com/cached');
      expect(mocked.calls).toHaveLength(4);
    } finally {
      mocked.restore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('does not cache failed API responses', async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), 'raynard-sdk-cache-'));
    const mocked = mockFetch(() => ({ status: 503, body: { message: 'Unavailable' } }));
    try {
      configureApiCache({ enabled: true, ttlHours: 24, directory: cacheDir });
      await expect(apiGet('https://api.example.com/failing')).rejects.toThrow(/HTTP 503/);
      await expect(apiGet('https://api.example.com/failing')).rejects.toThrow(/HTTP 503/);
      expect(mocked.calls).toHaveLength(2);
      expect(await readdir(cacheDir).catch(() => [])).toHaveLength(0);
    } finally {
      mocked.restore();
      await rm(cacheDir, { recursive: true, force: true });
    }
  });

  it('creates citeable references and validates complete tool results', () => {
    const reference = createApiReference({
      id: '42',
      label: 'Record 42',
      sourceUrl: 'https://api.example.com/items/42',
      quote: 'Record 42 is active.',
      payload: { id: 42, active: true }
    });
    const result = {
      text: 'Record 42 is active.',
      references: [reference],
      data: { id: 42, active: true }
    };

    expect(expectToolResult(result)).toBe(result);
    expect(assertToolResult(result)).toBe(result);
    expect(reference.referenceMeta.sourceUrl).toBe('https://api.example.com/items/42');
  });

  it('provides common argument validation', () => {
    expect(requireNonEmpty('  fox  ', 'query')).toBe('fox');
    expect(requirePositiveInt(3, 'limit')).toBe(3);
    expect(() => requirePositiveInt(0, 'limit')).toThrow(/positive integer/);
  });
});
