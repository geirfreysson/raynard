import { describe, expect, it } from 'vitest';

import {
  decodeSharePayload,
  deepLinkFor,
  encodeSharePayload,
  shareLinkFor,
  validateSharePayload
} from './codec';
import { SHARE_PAYLOAD_VERSION, ShareLinkError } from './types';
import type { SharedAnswerPayload } from './types';

function payload(overrides: Partial<SharedAnswerPayload> = {}): SharedAnswerPayload {
  return {
    v: SHARE_PAYLOAD_VERSION,
    at: '2026-08-18T10:00:00.000Z',
    q: 'What is the population of Iceland?',
    a: 'About 390,000 people.[^1]',
    teaser: { cards: '1 observation', ext: 'World Bank Data360' },
    ...overrides
  };
}

describe('encode/decode', () => {
  it('round-trips a payload', async () => {
    const original = payload({ cards: [], sources: [] });
    const restored = await decodeSharePayload(await encodeSharePayload(original));
    expect(restored).toEqual(original);
  });

  it('round-trips unicode in the question and answer', async () => {
    const original = payload({ q: 'Hvað búa margir á Íslandi? 🇮🇸', a: '~390.000 — “about”' });
    const restored = await decodeSharePayload(await encodeSharePayload(original));
    expect(restored.q).toBe(original.q);
    expect(restored.a).toBe(original.a);
  });

  it('emits base64url only, so the string survives a URL fragment and a path segment', async () => {
    // Padding and the two non-URL-safe base64 characters must never appear.
    const encoded = await encodeSharePayload(
      payload({ a: 'x'.repeat(1000), q: Array.from({ length: 40 }, (_, i) => `q${i}`).join(' ') })
    );
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encoded).not.toContain('=');
  });

  it('rejects an empty link', async () => {
    await expect(decodeSharePayload('   ')).rejects.toBeInstanceOf(ShareLinkError);
  });

  it('rejects a string that is not a share payload', async () => {
    await expect(decodeSharePayload('not-a-real-payload')).rejects.toBeInstanceOf(ShareLinkError);
  });
});

describe('validateSharePayload', () => {
  it('rejects a newer payload version', () => {
    expect(() => validateSharePayload({ ...payload(), v: SHARE_PAYLOAD_VERSION + 1 })).toThrow(
      ShareLinkError
    );
  });

  it('rejects valid JSON that is missing the answer', () => {
    const { a: _a, ...rest } = payload();
    expect(() => validateSharePayload(rest)).toThrow(ShareLinkError);
  });

  it('rejects cards that are not an array', () => {
    expect(() => validateSharePayload({ ...payload(), cards: {} })).toThrow(ShareLinkError);
  });

  it('rejects sources that are not an array', () => {
    expect(() => validateSharePayload({ ...payload(), sources: 'nope' })).toThrow(ShareLinkError);
  });

  it('rejects a non-object', () => {
    expect(() => validateSharePayload(null)).toThrow(ShareLinkError);
  });
});

describe('link builders', () => {
  it('puts the payload in the fragment, where it is never sent to the server', () => {
    expect(shareLinkFor('ABC', 'https://raynard.ai')).toBe('https://raynard.ai/s#ABC');
  });

  it('tolerates a trailing slash on the base URL', () => {
    expect(shareLinkFor('ABC', 'http://localhost:3000/')).toBe('http://localhost:3000/s#ABC');
  });

  it('uses a path segment for the deep link, not a fragment', () => {
    expect(deepLinkFor('ABC', 'raynard')).toBe('raynard://share/ABC');
  });
});
