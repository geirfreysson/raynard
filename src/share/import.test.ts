import { describe, expect, it } from 'vitest';

import { decodeExtensionRecommendation } from '../extension-recommendation';
import type { StoredResultCard } from '../result-card/types';
import { messagesFromSharedPayload, recommendationForShare } from './import';
import { SHARE_PAYLOAD_VERSION } from './types';
import type { SharedAnswerPayload } from './types';

const card: StoredResultCard = {
  toolName: 'dnd_monster',
  template: {
    name: { singular: 'monster', plural: 'monsters' },
    layout: [{ component: 'KeyValue', pairs: [{ label: 'HP', field: 'hp' }] }]
  },
  data: { hp: 15 }
};

function payload(overrides: Partial<SharedAnswerPayload> = {}): SharedAnswerPayload {
  return {
    v: SHARE_PAYLOAD_VERSION,
    at: '2026-08-18T10:00:00.000Z',
    q: 'How tough is an orc?',
    a: 'Not very — 15 hit points.[^1]',
    teaser: { cards: '1 monster', ext: 'D&D 5e API' },
    ...overrides
  };
}

describe('messagesFromSharedPayload', () => {
  it('rebuilds the question and answer as a message pair', () => {
    const { user, assistant } = messagesFromSharedPayload(payload(), 1000);

    expect(user).toEqual({ role: 'user', text: 'How tough is an orc?', timestamp: 1000 });
    expect(assistant.role).toBe('assistant');
    expect(assistant.text).toBe('Not very — 15 hit points.[^1]');
    expect(assistant.status).toBe('completed');
    // Ordered after the question so the transcript renders in the right order.
    expect(assistant.timestamp).toBeGreaterThan(user.timestamp);
  });

  it('carries cards and sources onto the assistant message', () => {
    const sources = [{ plugin: 'D&D 5e API', label: 'Orc', cardIndex: 0 }];
    const charts = [
      {
        type: 'bar' as const,
        x: 'monster',
        series: [{ key: 'hp', label: 'HP' }],
        rows: [{ monster: 'Orc', hp: 15 }]
      }
    ];
    const { assistant } = messagesFromSharedPayload(payload({ cards: [card], charts, sources }), 1000);
    expect(assistant.cards).toEqual([card]);
    expect(assistant.charts).toEqual(charts);
    expect(assistant.sources).toEqual(sources);
  });

  it('omits empty collections', () => {
    const { assistant } = messagesFromSharedPayload(payload(), 1000);
    expect(assistant.cards).toBeUndefined();
    expect(assistant.charts).toBeUndefined();
    expect(assistant.sources).toBeUndefined();
  });
});

describe('recommendationForShare', () => {
  const catalog = [
    { slug: 'dnd-5e-api', name: 'D&D 5e API', description: 'Monsters and spells.', installed: false },
    { slug: 'hacker-news', name: 'Hacker News', description: 'Stories.', installed: true }
  ];

  it('offers an uninstalled extension in a shape the existing install card accepts', () => {
    const recommendation = recommendationForShare(
      payload({ ext: [{ slug: 'dnd-5e-api', name: 'D&D 5e API' }] }),
      catalog
    );
    expect(recommendation).toEqual({
      slug: 'dnd-5e-api',
      name: 'D&D 5e API',
      description: 'Monsters and spells.',
      answer: 'Not very — 15 hit points.[^1]'
    });
    // The host renders it through decodeExtensionRecommendation, so it must survive that.
    expect(decodeExtensionRecommendation(recommendation)).toEqual(recommendation);
  });

  it('stays quiet when the extension is already installed', () => {
    expect(
      recommendationForShare(payload({ ext: [{ slug: 'hacker-news', name: 'Hacker News' }] }), catalog)
    ).toBeNull();
  });

  it('stays quiet for a user-built plugin, which has no slug to install', () => {
    expect(recommendationForShare(payload({ ext: [{ name: 'My local plugin' }] }), catalog)).toBeNull();
  });

  it('stays quiet when the slug is not in the catalog', () => {
    expect(
      recommendationForShare(payload({ ext: [{ slug: 'not-bundled', name: 'Nope' }] }), catalog)
    ).toBeNull();
  });

  it('stays quiet when there are no extensions at all', () => {
    expect(recommendationForShare(payload(), catalog)).toBeNull();
  });

  it('skips installed extensions to reach an uninstalled one', () => {
    const recommendation = recommendationForShare(
      payload({
        ext: [
          { slug: 'hacker-news', name: 'Hacker News' },
          { slug: 'dnd-5e-api', name: 'D&D 5e API' }
        ]
      }),
      catalog
    );
    expect(recommendation?.slug).toBe('dnd-5e-api');
  });

  it('stays quiet when the answer is empty, since the card would have nothing to show', () => {
    expect(
      recommendationForShare(
        payload({ a: '   ', ext: [{ slug: 'dnd-5e-api', name: 'D&D 5e API' }] }),
        catalog
      )
    ).toBeNull();
  });
});
