import { describe, expect, it } from 'vitest';

import { cardCountLabel } from '../result-card/ResultCardStack';
import type { StoredResultCard } from '../result-card/types';
import { buildSharePayload } from './payload';
import { SHARE_PAYLOAD_VERSION, ShareLinkError } from './types';

function card(singular: string, plural: string, data: unknown = { hp: 1 }): StoredResultCard {
  return {
    toolName: `tool_${singular}`,
    template: {
      name: { singular, plural },
      layout: [{ component: 'KeyValue', pairs: [{ label: 'HP', field: 'hp' }] }]
    },
    data
  };
}

const at = () => Date.parse('2026-08-18T10:00:00.000Z');

describe('buildSharePayload', () => {
  it('carries the question, answer, cards and sources', () => {
    const cards = [card('monster', 'monsters')];
    const sources = [{ plugin: 'D&D 5e', label: 'Orc' }];
    const payload = buildSharePayload({
      question: '  How tough is an orc?  ',
      message: { text: 'Not very.[^1]', cards, sources },
      extensions: [{ slug: 'dnd-5e-api', name: 'D&D 5e API' }],
      now: at
    });

    expect(payload.v).toBe(SHARE_PAYLOAD_VERSION);
    expect(payload.at).toBe('2026-08-18T10:00:00.000Z');
    expect(payload.q).toBe('How tough is an orc?');
    expect(payload.a).toBe('Not very.[^1]');
    expect(payload.cards).toEqual(cards);
    expect(payload.sources).toEqual(sources);
    expect(payload.ext).toEqual([{ slug: 'dnd-5e-api', name: 'D&D 5e API' }]);
  });

  it('computes the teaser with the same label the app shows', () => {
    const cards = [card('monster', 'monsters'), card('monster', 'monsters'), card('spell', 'spells')];
    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a', cards },
      extensions: [{ name: 'D&D 5e API' }, { name: 'Open Library' }],
      now: at
    });

    expect(payload.teaser.cards).toBe(cardCountLabel(cards));
    expect(payload.teaser.cards).toBe('2 monsters · 1 spell');
    expect(payload.teaser.ext).toBe('D&D 5e API · Open Library');
  });

  it('omits empty collections rather than shipping empty arrays', () => {
    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a' },
      extensions: [],
      now: at
    });
    expect(payload.cards).toBeUndefined();
    expect(payload.sources).toBeUndefined();
    expect(payload.ext).toBeUndefined();
    expect(payload.teaser).toEqual({ cards: '', ext: '' });
  });

  it('strips the machine-local artifact ref', () => {
    const withArtifact: StoredResultCard = {
      ...card('row', 'rows'),
      cached: true,
      artifact: { chatId: 'chat-123', artifactId: 'message-0-card-0', byteCount: 900_000 }
    };
    // A hydrated card has real data and no ref; simulate what the modal hands over.
    const hydrated: StoredResultCard = { ...withArtifact, data: { hp: 7 }, artifact: undefined };

    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a', cards: [hydrated] },
      extensions: [],
      now: at
    });

    expect(payload.cards?.[0]).not.toHaveProperty('artifact');
    expect(JSON.stringify(payload)).not.toContain('chat-123');
    // Provenance the recipient can act on is kept.
    expect(payload.cards?.[0].cached).toBe(true);
  });

  it('refuses an unhydrated card rather than sending an empty one', () => {
    const unhydrated: StoredResultCard = {
      ...card('row', 'rows', {}),
      artifact: { chatId: 'chat-9', artifactId: 'message-0-card-0', byteCount: 500_000 }
    };
    expect(() =>
      buildSharePayload({
        question: 'q',
        message: { text: 'a', cards: [unhydrated] },
        extensions: [],
        now: at
      })
    ).toThrow(ShareLinkError);
  });

  it('leaves behind everything that identifies the sender or their session', () => {
    const payload = buildSharePayload({
      question: 'q',
      message: { text: 'a', cards: [card('row', 'rows')] },
      extensions: [],
      now: at
    });
    const keys = Object.keys(payload);
    for (const forbidden of [
      'usage',
      'provider',
      'model',
      'thinking',
      'builderRun',
      'builderActivities',
      'credentialRequest',
      'extensionRecommendation',
      'timestamp',
      'chatId',
      'status'
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
