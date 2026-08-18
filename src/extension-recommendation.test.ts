import { describe, expect, it } from 'vitest';

import { decodeExtensionRecommendation } from './extension-recommendation';

describe('decodeExtensionRecommendation', () => {
  it('accepts a complete catalog recommendation', () => {
    expect(
      decodeExtensionRecommendation({
        slug: 'open-library',
        name: 'Open Library',
        description: 'Search books and authors.',
        answer: 'Open Library can answer that.'
      })
    ).toEqual({
      slug: 'open-library',
      name: 'Open Library',
      description: 'Search books and authors.',
      answer: 'Open Library can answer that.'
    });
  });

  it('rejects malformed or unsafe recommendation slugs', () => {
    expect(decodeExtensionRecommendation({ slug: '../open-library', name: 'Open Library' })).toBeNull();
    expect(decodeExtensionRecommendation({ slug: 'open-library', name: '' })).toBeNull();
    expect(decodeExtensionRecommendation(null)).toBeNull();
  });
});
