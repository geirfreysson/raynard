import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MissingCredentialError,
  apiGet,
  assertCardTemplate,
  assertToolRegistry,
  assertToolResult,
  configureApiCache,
  configureCredentials,
  createApiReference,
  defineTools,
  getCredential,
  redactSecrets,
  requireCredential,
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
    configureCredentials({});
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

  describe('credentials', () => {
    it('reads a configured credential and trims it', () => {
      configureCredentials({ OPENWEATHER_API_KEY: '  secret-value-1234  ' });
      expect(getCredential('OPENWEATHER_API_KEY')).toBe('secret-value-1234');
      expect(requireCredential('OPENWEATHER_API_KEY')).toBe('secret-value-1234');
    });

    it('reports a missing credential as a typed, machine-readable error', () => {
      configureCredentials({});
      expect(getCredential('OPENWEATHER_API_KEY')).toBe('');

      let thrown;
      try {
        requireCredential('OPENWEATHER_API_KEY', 'OpenWeather API key');
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(MissingCredentialError);
      expect(thrown.name).toBe('MissingCredentialError');
      expect(thrown.credentialKey).toBe('OPENWEATHER_API_KEY');
      expect(thrown.credentialLabel).toBe('OpenWeather API key');
    });

    it('falls back to the key when no label is supplied', () => {
      expect(() => requireCredential('SOME_KEY')).toThrow(MissingCredentialError);
      try {
        requireCredential('SOME_KEY');
      } catch (error) {
        expect(error.credentialLabel).toBe('SOME_KEY');
      }
    });

    it('treats an empty value as unset so a blank keychain entry still prompts', () => {
      configureCredentials({ OPENWEATHER_API_KEY: '   ' });
      expect(() => requireCredential('OPENWEATHER_API_KEY')).toThrow(MissingCredentialError);
    });

    it('fully replaces prior state so one plugin never sees another plugin credential', () => {
      configureCredentials({ FIRST_KEY: 'first-secret-value' });
      configureCredentials({ SECOND_KEY: 'second-secret-value' });
      expect(getCredential('SECOND_KEY')).toBe('second-secret-value');
      expect(getCredential('FIRST_KEY')).toBe('');
    });

    it('redacts configured values from arbitrary text', () => {
      configureCredentials({ OPENWEATHER_API_KEY: 'super-secret-key-value' });
      expect(redactSecrets('called with appid=super-secret-key-value&q=oslo')).toBe(
        'called with appid=***&q=oslo'
      );
    });

    it('leaves short values alone rather than redacting ordinary words', () => {
      configureCredentials({ SHORT: 'abc' });
      expect(redactSecrets('abc is not a secret')).toBe('abc is not a secret');
    });

    it('keeps a query-parameter key out of the apiGet failure message', async () => {
      configureCredentials({ OPENWEATHER_API_KEY: 'super-secret-key-value' });
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(JSON.stringify({ message: 'invalid appid super-secret-key-value' }), {
          status: 401
        })
      );

      let message = '';
      try {
        await apiGet('https://api.example.com/weather', {
          query: { appid: requireCredential('OPENWEATHER_API_KEY'), q: 'oslo' }
        });
      } catch (error) {
        message = error.message;
      }

      // Both the request URL and the upstream error body carry the key.
      expect(message).not.toContain('super-secret-key-value');
      expect(message).toContain('***');
      expect(message).toContain('HTTP 401');
    });
  });
});
