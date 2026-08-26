/**
 * The share sheet.
 *
 * Turning an answer into a link is not instant — artifact-backed cards have to
 * be read back off disk, and the payload is encoded and measured before anyone
 * is shown a URL. So this is a small state machine: preparing, then either a
 * link, a link with an honest note about what was trimmed, or a refusal.
 *
 * The modal is created on first use and reused, like the citation modal. A
 * generation counter guards the async work so a second Share click cannot have
 * its result overwritten by the first one finishing late.
 */

import { bookmarkPreview } from '../bookmarks';
import type { ChartSource } from '../chart-sources';
import type { ChartSpec } from '../chart-spec';
import { hydrateResultCards, type ResultArtifactLoader } from '../result-card/artifacts';
import type { StoredResultCard } from '../result-card/types';
import { shareLinkFor } from './codec';
import { fitSharePayload } from './degrade';
import { buildSharePayload } from './payload';
import type { ShareExtension, SharedAnswerPayload } from './types';

export type ShareModalInput = {
  question: string;
  message: {
    text: string;
    cards?: StoredResultCard[];
    charts?: ChartSpec[];
    sources?: ChartSource[];
  };
  extensions: ShareExtension[];
  loadArtifact: ResultArtifactLoader;
  baseUrl: string;
  /** Injected so tests do not need a real clipboard. Returns false if nothing landed. */
  copy: (text: string) => Promise<boolean>;
  openExternal: (url: string) => Promise<void>;
};

/** How long a Copied/Copy failed label stays before reverting. */
const COPY_FEEDBACK_MS = 1400;

let modal: HTMLElement | null = null;
let generation = 0;

/**
 * Phrase what the ladder gave up, or null when there is nothing worth saying.
 *
 * Projection alone is deliberately silent: it only removes fields no card
 * template reads, so a recipient sees exactly what the sender saw. Trimmed rows
 * and dropped cards are real losses and always get a line.
 */
export function describeDegradation(payload: SharedAnswerPayload): string | null {
  const degraded = payload.degraded;
  if (!degraded) return null;

  const parts: string[] = [];
  if (degraded.rows?.length) {
    const shown = degraded.rows.reduce((sum, row) => sum + row.shown, 0);
    const total = degraded.rows.reduce((sum, row) => sum + row.total, 0);
    parts.push(`tables trimmed to ${shown.toLocaleString()} of ${total.toLocaleString()} rows`);
  }
  if (degraded.droppedCards) {
    const count = degraded.droppedCards;
    parts.push(`${count} result ${count === 1 ? 'card' : 'cards'} left out`);
  }
  if (degraded.citationPayloads) parts.push('citation excerpts omitted');

  if (!parts.length) return null;
  return `To fit in a link: ${parts.join(', ')}.`;
}

export function openShareModal(input: ShareModalInput): void {
  const host = ensureModal();
  const body = host.querySelector<HTMLElement>('.share-modal-body');
  if (!body) return;

  const run = ++generation;
  body.textContent = '';
  body.appendChild(status('Preparing link…'));

  host.classList.remove('is-hidden');
  host.setAttribute('aria-hidden', 'false');
  host.querySelector<HTMLButtonElement>('.share-modal-close')?.focus();

  void prepare(input)
    .then((ready) => {
      if (run !== generation) return;
      body.textContent = '';
      renderReady(body, ready, input);
    })
    .catch((error: unknown) => {
      if (run !== generation) return;
      body.textContent = '';
      body.appendChild(
        status(error instanceof Error ? error.message : 'This answer could not be shared.', 'error')
      );
    });
}

type ReadyShare = { payload: SharedAnswerPayload; link: string; overBudget: boolean };

async function prepare(input: ShareModalInput): Promise<ReadyShare> {
  // Cards whose data was externalized carry only a local artifact ref; the data
  // has to come back off disk before it can travel. `hydrateResultCards` fills
  // `data` but leaves the ref in place — right for re-rendering in the app,
  // wrong for a payload leaving the machine, so it is dropped here. That keeps
  // `buildSharePayload`'s guard meaningful: it still catches a card nobody
  // hydrated at all.
  const hydrated = await hydrateResultCards(input.message.cards ?? [], input.loadArtifact);
  const cards = hydrated.map(({ artifact: _artifact, ...card }) => card);

  const payload = buildSharePayload({
    question: input.question,
    message: { ...input.message, cards },
    extensions: input.extensions
  });

  const fitted = await fitSharePayload(payload);
  return {
    payload: fitted.payload,
    link: shareLinkFor(fitted.encoded, input.baseUrl),
    overBudget: Boolean(fitted.payload.degraded?.overBudget)
  };
}

function renderReady(body: HTMLElement, ready: ReadyShare, input: ShareModalInput): void {
  body.appendChild(teaser(ready.payload));

  if (ready.overBudget) {
    // Never hand over a link that is too long to survive the trip.
    body.appendChild(
      status(
        'This answer is too large to share as a link, even after trimming. You can copy the text instead.',
        'error'
      )
    );
    body.appendChild(
      actions([
        button('Copy answer text', 'primary', (element) =>
          copyInto(element, ready.payload.a, input.copy, 'Copy answer text')
        )
      ])
    );
    return;
  }

  const note = describeDegradation(ready.payload);
  if (note) body.appendChild(status(note, 'note'));

  const field = document.createElement('input');
  field.className = 'share-modal-link';
  field.type = 'text';
  field.readOnly = true;
  field.value = ready.link;
  field.setAttribute('aria-label', 'Share link');
  field.addEventListener('focus', () => field.select());
  body.appendChild(field);

  body.appendChild(
    actions([
      button('Copy link', 'primary', (element) =>
        copyInto(element, ready.link, input.copy, 'Copy link')
      ),
      button('Open preview', 'secondary', () => void input.openExternal(ready.link))
    ])
  );

  body.appendChild(
    status('Anyone with this link needs Raynard to open it. Nothing is uploaded.', 'hint')
  );
}

function teaser(payload: SharedAnswerPayload): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'share-modal-teaser';

  const question = document.createElement('p');
  question.className = 'share-modal-question';
  question.textContent = bookmarkPreview(payload.q, 120);
  wrapper.appendChild(question);

  const meta = [payload.teaser.cards, payload.teaser.ext].filter(Boolean).join(' · ');
  if (meta) {
    const line = document.createElement('p');
    line.className = 'share-modal-meta';
    line.textContent = meta;
    wrapper.appendChild(line);
  }
  return wrapper;
}

async function copyInto(
  element: HTMLButtonElement,
  text: string,
  copy: (value: string) => Promise<boolean>,
  label: string
): Promise<void> {
  const ok = await copy(text);
  element.textContent = ok ? 'Copied' : 'Copy failed';
  element.classList.toggle('is-copied', ok);
  element.classList.toggle('is-failed', !ok);
  window.setTimeout(() => {
    element.textContent = label;
    element.classList.remove('is-copied', 'is-failed');
  }, COPY_FEEDBACK_MS);
}

function status(text: string, tone: 'plain' | 'error' | 'note' | 'hint' = 'plain'): HTMLElement {
  const element = document.createElement('p');
  element.className = `share-modal-status is-${tone}`;
  element.textContent = text;
  return element;
}

function actions(children: HTMLElement[]): HTMLElement {
  const row = document.createElement('div');
  row.className = 'share-modal-actions';
  for (const child of children) row.appendChild(child);
  return row;
}

function button(
  label: string,
  variant: 'primary' | 'secondary',
  onClick: (element: HTMLButtonElement) => void
): HTMLButtonElement {
  const element = document.createElement('button');
  element.type = 'button';
  element.className = `share-modal-button is-${variant}`;
  element.textContent = label;
  element.addEventListener('click', () => onClick(element));
  return element;
}

export function closeShareModal(): void {
  if (!modal) return;
  // Bump the generation so in-flight work cannot repopulate a closed modal.
  generation += 1;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

function ensureModal(): HTMLElement {
  if (modal) return modal;

  const host = document.createElement('section');
  host.className = 'share-modal-overlay is-hidden';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = `
    <div class="share-modal" role="dialog" aria-modal="true" aria-labelledby="shareModalTitle">
      <header class="share-modal-header">
        <h2 id="shareModalTitle" class="share-modal-title">Share this answer</h2>
        <button class="share-modal-close" type="button" aria-label="Close share">x</button>
      </header>
      <div class="share-modal-body"></div>
    </div>
  `;

  host.addEventListener('click', (event) => {
    if (event.target === host) closeShareModal();
  });
  host.querySelector('.share-modal-close')?.addEventListener('click', closeShareModal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeShareModal();
  });

  document.body.appendChild(host);
  modal = host;
  return host;
}

/** Test seam: drops the cached modal so each case starts from a clean DOM. */
export function resetShareModal(): void {
  modal?.remove();
  modal = null;
  generation = 0;
}
