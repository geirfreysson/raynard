// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { StoredResultCard } from '../result-card/types';
import { decodeSharePayload } from './codec';
import { SHARE_MAX_CARDS } from './degrade';
import { describeDegradation, openShareModal, resetShareModal, type ShareModalInput } from './share-modal';
import { SHARE_PAYLOAD_VERSION } from './types';
import type { SharedAnswerPayload } from './types';

afterEach(() => {
  resetShareModal();
  document.body.textContent = '';
  vi.useRealTimers();
});

function card(index = 0, rows = 3): StoredResultCard {
  return {
    toolName: `tool_${index}`,
    template: {
      name: { singular: 'observation', plural: 'observations' },
      layout: [{ component: 'Table', columns: [{ header: 'Year', field: 'y' }], rows: 'rows' }]
    },
    data: { rows: Array.from({ length: rows }, (_, i) => ({ y: 1900 + i, drop: 'x'.repeat(40) })) }
  };
}

function input(overrides: Partial<ShareModalInput> = {}): ShareModalInput {
  return {
    question: 'What happened to the population?',
    message: { text: 'It rose.', cards: [card()] },
    extensions: [{ slug: 'world-bank-data360', name: 'World Bank Data360' }],
    loadArtifact: async () => ({}),
    baseUrl: 'http://localhost:3000',
    copy: async () => true,
    openExternal: async () => {},
    ...overrides
  };
}

const body = () => document.querySelector<HTMLElement>('.share-modal-body')!;
const link = () => document.querySelector<HTMLInputElement>('.share-modal-link');
const buttons = () => [...document.querySelectorAll<HTMLButtonElement>('.share-modal-button')];
const buttonNamed = (label: string) => buttons().find((b) => b.textContent === label);
const statuses = () => [...document.querySelectorAll('.share-modal-status')].map((n) => n.textContent);

/**
 * Wait until the sheet leaves its preparing state.
 *
 * The prepare chain awaits artifact loading, encoding, and the compression
 * stream, so a single macrotask tick is not enough and any fixed delay would be
 * a flake waiting to happen. Poll the state the test actually cares about.
 */
async function settle(timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (body().textContent?.includes('Preparing link…')) {
    if (Date.now() > deadline) throw new Error('share modal never left the preparing state');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('openShareModal', () => {
  it('shows a preparing state before the link exists', () => {
    openShareModal(input());
    expect(body().textContent).toContain('Preparing link…');
    expect(link()).toBeNull();
  });

  it('renders the teaser and a copyable link', async () => {
    openShareModal(input());
    await settle();

    expect(document.querySelector('.share-modal-question')?.textContent).toBe(
      'What happened to the population?'
    );
    expect(document.querySelector('.share-modal-meta')?.textContent).toBe(
      '1 observation · World Bank Data360'
    );

    const field = link();
    expect(field).not.toBeNull();
    expect(field!.value.startsWith('http://localhost:3000/s#')).toBe(true);
    expect(field!.readOnly).toBe(true);
  });

  it('produces a link whose fragment decodes back to the answer', async () => {
    openShareModal(input());
    await settle();

    const encoded = link()!.value.split('#')[1];
    const payload = await decodeSharePayload(encoded);
    expect(payload.v).toBe(SHARE_PAYLOAD_VERSION);
    expect(payload.q).toBe('What happened to the population?');
    expect(payload.a).toBe('It rose.');
    expect(payload.ext?.[0].slug).toBe('world-bank-data360');
  });

  it('hydrates artifact-backed cards before encoding', async () => {
    const loadArtifact = vi.fn(async () => ({ rows: [{ y: 1999 }] }));
    const backed: StoredResultCard = {
      ...card(),
      data: {},
      artifact: { chatId: 'chat-1', artifactId: 'message-0-card-0', byteCount: 900_000 }
    };

    openShareModal(input({ message: { text: 'a', cards: [backed] }, loadArtifact }));
    await settle();

    expect(loadArtifact).toHaveBeenCalledOnce();
    const payload = await decodeSharePayload(link()!.value.split('#')[1]);
    // The local chat id must not travel with the card.
    expect(JSON.stringify(payload)).not.toContain('chat-1');
    expect(payload.cards?.[0]).not.toHaveProperty('artifact');
  });

  it('copies the link and reports success, then reverts', async () => {
    const copy = vi.fn(async () => true);
    openShareModal(input({ copy }));
    // Real timers while preparing; fake ones only to fast-forward the revert.
    await settle();
    const url = link()!.value;

    const button = buttonNamed('Copy link')!;
    vi.useFakeTimers();
    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(copy).toHaveBeenCalledWith(url);
    expect(button.textContent).toBe('Copied');
    expect(button.classList.contains('is-copied')).toBe(true);

    await vi.advanceTimersByTimeAsync(1500);
    expect(button.textContent).toBe('Copy link');
    expect(button.classList.contains('is-copied')).toBe(false);
  });

  it('says so when the clipboard write does not land', async () => {
    openShareModal(input({ copy: async () => false }));
    await settle();

    const button = buttonNamed('Copy link')!;
    vi.useFakeTimers();
    button.click();
    await vi.advanceTimersByTimeAsync(0);

    expect(button.textContent).toBe('Copy failed');
    expect(button.classList.contains('is-failed')).toBe(true);
  });

  it('opens the preview through the injected opener', async () => {
    const openExternal = vi.fn(async () => {});
    openShareModal(input({ openExternal }));
    await settle();

    buttonNamed('Open preview')!.click();
    expect(openExternal).toHaveBeenCalledWith(link()!.value);
  });

  it('names what was trimmed when the ladder had to degrade', async () => {
    // Nine card-heavy results force row capping and dropped cards.
    const cards = Array.from({ length: 9 }, (_, index) => card(index, 4000));
    openShareModal(input({ message: { text: 'a', cards } }));
    await settle();

    const note = statuses().find((text) => text?.startsWith('To fit in a link:'));
    expect(note).toBeTruthy();
    expect(note).toContain('rows');
    // A degraded link is still a working link.
    expect(link()).not.toBeNull();
  });

  it('refuses to show a link it knows is too long', async () => {
    // Answer text is never truncated, so a huge answer cannot be made to fit.
    const text = Array.from({ length: 40_000 }, (_, i) => `w${i}`).join(' ');
    openShareModal(input({ message: { text } }));
    await settle();

    expect(link()).toBeNull();
    expect(statuses().some((s) => s?.includes('too large to share as a link'))).toBe(true);
    expect(buttonNamed('Copy answer text')).toBeTruthy();
    expect(buttonNamed('Copy link')).toBeUndefined();
  });

  it('surfaces a failure instead of hanging on Preparing', async () => {
    openShareModal(
      input({
        loadArtifact: async () => {
          throw new Error('Artifact is missing.');
        },
        message: {
          text: 'a',
          cards: [{ ...card(), artifact: { chatId: 'c', artifactId: 'a', byteCount: 1 } }]
        }
      })
    );
    await settle();

    expect(body().textContent).not.toContain('Preparing link…');
    expect(statuses().some((s) => s?.includes('Artifact is missing.'))).toBe(true);
  });

  it('closes on Escape and on a backdrop click', async () => {
    openShareModal(input());
    await settle();
    const overlay = document.querySelector('.share-modal-overlay')!;
    expect(overlay.classList.contains('is-hidden')).toBe(false);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(overlay.classList.contains('is-hidden')).toBe(true);

    openShareModal(input());
    await settle();
    (overlay as HTMLElement).click();
    expect(overlay.classList.contains('is-hidden')).toBe(true);
  });

  it('does not let a slow first prepare overwrite a second open', async () => {
    let release: (value: unknown) => void = () => {};
    const slow = new Promise((resolve) => {
      release = resolve;
    });

    openShareModal(
      input({
        question: 'first',
        message: {
          text: 'a',
          cards: [{ ...card(), artifact: { chatId: 'c', artifactId: 'a', byteCount: 1 } }]
        },
        loadArtifact: async () => {
          await slow;
          return { rows: [] };
        }
      })
    );
    openShareModal(input({ question: 'second' }));
    await settle();
    expect(document.querySelector('.share-modal-question')?.textContent).toBe('second');

    release({});
    await settle();
    // The stale run must not repaint the sheet.
    expect(document.querySelector('.share-modal-question')?.textContent).toBe('second');
  });
});

describe('describeDegradation', () => {
  const base: SharedAnswerPayload = {
    v: SHARE_PAYLOAD_VERSION,
    at: '2026-08-18T10:00:00.000Z',
    q: 'q',
    a: 'a',
    teaser: { cards: '', ext: '' }
  };

  it('says nothing when nothing was given up', () => {
    expect(describeDegradation(base)).toBeNull();
  });

  it('stays silent about projection, which removes nothing a reader could see', () => {
    expect(describeDegradation({ ...base, degraded: { projected: true } })).toBeNull();
  });

  it('reports trimmed rows with real totals', () => {
    const note = describeDegradation({
      ...base,
      degraded: { projected: true, rows: [{ card: 0, shown: 100, total: 4000 }] }
    });
    expect(note).toBe('To fit in a link: tables trimmed to 100 of 4,000 rows.');
  });

  it('reports dropped cards, singular and plural', () => {
    expect(describeDegradation({ ...base, degraded: { droppedCards: 1 } })).toContain(
      '1 result card left out'
    );
    expect(describeDegradation({ ...base, degraded: { droppedCards: SHARE_MAX_CARDS } })).toContain(
      `${SHARE_MAX_CARDS} result cards left out`
    );
  });

  it('reports citation excerpts', () => {
    expect(describeDegradation({ ...base, degraded: { citationPayloads: true } })).toBe(
      'To fit in a link: citation excerpts omitted.'
    );
  });
});
