import { describe, expect, it } from 'vitest';
import { normalizeChartFenceBoundaries } from './chart-markdown';

const chart =
  '```chart\n{"type":"bar","x":"country","series":[{"key":"value"}],"rows":[{"country":"Iceland","value":1}]}\n```';

describe('normalizeChartFenceBoundaries', () => {
  it('repairs a valid chart fence glued to tool-round narration', () => {
    expect(normalizeChartFenceBoundaries(`Let me search for a source:${chart}`)).toBe(
      `Let me search for a source:\n\n${chart}`
    );
  });

  it('leaves an already aligned chart fence unchanged', () => {
    expect(normalizeChartFenceBoundaries(`Answer:\n\n${chart}\n\nDone.`)).toBe(
      `Answer:\n\n${chart}\n\nDone.`
    );
  });

  it('does not promote an invalid chart body into a block', () => {
    const malformed = 'Explain this:```chart\nnot json\n```';
    expect(normalizeChartFenceBoundaries(malformed)).toBe(malformed);
  });
});
