import { describe, expect, it } from 'vitest';
import { resultWasCached } from './cache';

describe('resultWasCached', () => {
  it('accepts only the reserved boolean cache-hit marker', () => {
    expect(resultWasCached({ _raynard: { cacheHit: true } })).toBe(true);
    expect(resultWasCached({ _raynard: { cacheHit: false } })).toBe(false);
    expect(resultWasCached({ _raynard: { cacheHit: 'true' } })).toBe(false);
    expect(resultWasCached({ cacheHit: true })).toBe(false);
    expect(resultWasCached(null)).toBe(false);
  });
});
