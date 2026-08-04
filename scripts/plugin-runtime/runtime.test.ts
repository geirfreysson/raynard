import { describe, expect, it } from 'vitest';
import {
  apiGet,
  buildQuery,
  createApiReference,
  requireNonEmpty,
  requirePositiveInt
} from './runtime';
import { expectToolResult, mockFetch } from './testing';

describe('buildQuery', () => {
  it('skips undefined/null/empty and encodes the rest in order', () => {
    expect(buildQuery({ a: 1, b: undefined, c: null, d: '', e: 'x y' })).toBe('?a=1&e=x+y');
    expect(buildQuery()).toBe('');
  });
});

describe('apiGet', () => {
  it('appends query params and returns parsed JSON', async () => {
    const fetchMock = mockFetch((url) => ({ body: { url } }));
    try {
      const result = await apiGet<{ url: string }>('https://api.example.com/things', {
        query: { min: 5, max: undefined }
      });
      expect(result.url).toBe('https://api.example.com/things?min=5');
      expect(fetchMock.calls).toEqual(['https://api.example.com/things?min=5']);
    } finally {
      fetchMock.restore();
    }
  });

  it('throws a descriptive error using the body error field on non-2xx', async () => {
    const fetchMock = mockFetch(() => ({ status: 404, body: { error: 'Not found' } }));
    try {
      await expect(apiGet('https://api.example.com/x')).rejects.toThrow(/HTTP 404.*Not found/);
    } finally {
      fetchMock.restore();
    }
  });
});

describe('createApiReference', () => {
  it('produces a citation card and defaults fetchedAt', () => {
    const ref = createApiReference({
      id: '1',
      label: 'Apple',
      sourceUrl: 'https://example.com/1',
      quote: 'Apple',
      payload: { id: 1 }
    });
    expect(ref.referenceId).toBe('1');
    expect(ref.referenceMeta.sourceUrl).toBe('https://example.com/1');
    expect(typeof ref.referenceMeta.fetchedAt).toBe('string');
    expect(ref.expandedContent.at(-1)).toMatchObject({ type: 'json' });
  });
});

describe('validators', () => {
  it('requireNonEmpty trims and rejects blanks', () => {
    expect(requireNonEmpty('  hi ', 'Name')).toBe('hi');
    expect(() => requireNonEmpty('   ', 'Name')).toThrow(/Name/);
  });

  it('requirePositiveInt rejects non-positive and non-integer values', () => {
    expect(requirePositiveInt('4', 'Id')).toBe(4);
    expect(() => requirePositiveInt(0, 'Id')).toThrow(/Id/);
    expect(() => requirePositiveInt('x', 'Id')).toThrow(/Id/);
  });
});

describe('expectToolResult', () => {
  it('enforces non-empty text and at least one reference', () => {
    expect(expectToolResult({ text: 'ok', references: [{}] }).text).toBe('ok');
    expect(() => expectToolResult({ text: '', references: [{}] })).toThrow(/text/);
    expect(() => expectToolResult({ text: 'ok', references: [] })).toThrow(/citation/);
  });
});
