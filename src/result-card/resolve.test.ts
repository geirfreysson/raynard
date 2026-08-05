import { describe, expect, it } from 'vitest';
import { formatValue, getPath, interpolate, resolveRows } from './resolve';

describe('getPath', () => {
  it('reads nested object paths', () => {
    expect(getPath({ quote: { price: 182.5 } }, 'quote.price')).toBe(182.5);
  });

  it('indexes into arrays by numeric segment', () => {
    expect(getPath({ holdings: [{ symbol: 'AAPL' }] }, 'holdings.0.symbol')).toBe('AAPL');
  });

  it('returns undefined for missing paths without throwing', () => {
    expect(getPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(getPath(null, 'a')).toBeUndefined();
  });

  it('returns the whole value for an empty path', () => {
    const data = { a: 1 };
    expect(getPath(data, '')).toBe(data);
  });
});

describe('formatValue', () => {
  it('passes strings through and stringifies primitives', () => {
    expect(formatValue('hi')).toBe('hi');
    expect(formatValue(42)).toBe('42');
    expect(formatValue(true)).toBe('true');
  });

  it('renders null/undefined as empty string', () => {
    expect(formatValue(null)).toBe('');
    expect(formatValue(undefined)).toBe('');
  });

  it('compact-JSONs objects and arrays', () => {
    expect(formatValue({ a: 1 })).toBe('{"a":1}');
    expect(formatValue([1, 2])).toBe('[1,2]');
  });
});

describe('interpolate', () => {
  it('replaces {{path}} tokens with resolved values', () => {
    expect(interpolate('{{symbol}} — {{name}}', { symbol: 'AAPL', name: 'Apple' })).toBe('AAPL — Apple');
  });

  it('tolerates whitespace inside braces and missing fields', () => {
    expect(interpolate('#{{ id }} {{missing}}', { id: 7 })).toBe('#7 ');
  });

  it('returns empty string for empty template', () => {
    expect(interpolate('', { a: 1 })).toBe('');
  });
});

describe('resolveRows', () => {
  it('returns the array at the path', () => {
    expect(resolveRows({ rows: [{ x: 1 }] }, 'rows')).toEqual([{ x: 1 }]);
  });

  it('returns [] when the path is missing or not an array', () => {
    expect(resolveRows({}, 'rows')).toEqual([]);
    expect(resolveRows({ rows: 'nope' }, 'rows')).toEqual([]);
  });
});
