import { describe, expect, it } from 'vitest';

import { readDevShareHash } from './deep-link';

describe('readDevShareHash', () => {
  it('reads the dev backdoor hash', () => {
    expect(readDevShareHash('#share=AbC-_123')).toBe('AbC-_123');
  });

  it('ignores an ordinary hash', () => {
    expect(readDevShareHash('#some-anchor')).toBeNull();
    expect(readDevShareHash('')).toBeNull();
    expect(readDevShareHash('#share=')).toBeNull();
  });

  it('rejects a body that is not base64url', () => {
    expect(readDevShareHash('#share=AbC+def=')).toBeNull();
    expect(readDevShareHash('#share=../../etc')).toBeNull();
  });
});
