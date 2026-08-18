import { describe, expect, it, vi } from 'vitest';
import { hydrateResultCards } from './artifacts';
import type { StoredResultCard } from './types';

const template = {
  name: { singular: 'result', plural: 'results' },
  layout: []
};

describe('hydrateResultCards', () => {
  it('loads artifact-backed data while leaving inline cards untouched', async () => {
    const cards: StoredResultCard[] = [
      { toolName: 'small', template, data: { value: 1 } },
      {
        toolName: 'large',
        template,
        data: {},
        artifact: {
          chatId: 'chat-1',
          artifactId: 'stream-1-0',
          byteCount: 200_000
        }
      }
    ];
    const load = vi.fn(async () => ({ rows: [{ value: 2 }] }));

    const hydrated = await hydrateResultCards(cards, load);

    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(cards[1].artifact);
    expect(hydrated[0]).toBe(cards[0]);
    expect(hydrated[1]).toEqual({ ...cards[1], data: { rows: [{ value: 2 }] } });
  });
});
