import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  apiGet,
  assertCardTemplate,
  assertToolRegistry,
  assertToolResult,
  createApiReference,
  defineTools,
  requireNonEmpty,
  requirePositiveInt
} from './plugin-sdk/index.js';
import { expectToolResult, mockFetch } from './plugin-sdk/testing.js';

describe('shared generated-plugin SDK', () => {
  afterEach(() => {
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
