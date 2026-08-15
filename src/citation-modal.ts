/**
 * In-chat citations for host-rendered blocks.
 *
 * A chart or table drawn from plugin data gets a line of reference chips
 * underneath it. Clicking one opens the observation the numbers came from: the
 * tool's account of the reference, the result card that tool call rendered, and
 * a link out to the endpoint itself. The card is the same one shown under the
 * message — the plugin author's own presentation of the data, which reads far
 * better than the API's JSON. Raw payload is the fallback for a call that had
 * no card, and for messages saved before cards were recorded.
 *
 * The modal is created on first use and reused. Each chip closes over its own
 * citation, so a re-rendered message drops that data along with its nodes.
 */

import { citationsForDisplay, type ChartSource, type StoredCitation } from './chart-sources';
import { renderJson } from './json-view';
import { renderResultCards, unmountResultCards } from './result-card/mount';
import type { StoredResultCard } from './result-card/types';

/** Chips shown before the rest collapse into a count. */
const MAX_CHIPS = 6;

let modal: HTMLElement | null = null;
/** The card container currently mounted, so its React root is released. */
let cardMount: HTMLElement | null = null;

/**
 * Builds the citation line for a block, or null when the turn cited nothing.
 * The caller appends it beneath the chart or table it belongs to.
 */
export function createCitationLine(
  sources: ChartSource[],
  cards: StoredResultCard[] = []
): HTMLElement | null {
  const citations = citationsForDisplay(sources);
  if (!citations.length) return null;

  const line = document.createElement('p');
  line.className = 'block-sources';

  const lead = document.createElement('span');
  lead.className = 'block-sources-lead';
  lead.textContent = citations.length === 1 ? 'Source' : 'Sources';
  line.appendChild(lead);

  citations.slice(0, MAX_CHIPS).forEach(({ plugin, citation, cardIndex }) => {
    line.appendChild(createChip(plugin, citation, cards[cardIndex ?? -1]));
  });

  if (citations.length > MAX_CHIPS) {
    const rest = document.createElement('span');
    rest.className = 'block-sources-rest';
    rest.textContent = `+${citations.length - MAX_CHIPS} more`;
    line.appendChild(rest);
  }

  return line;
}

/**
 * The citation line for a chart: numbered markers for the calls whose rows it
 * plotted, as the chart spec declared them. Returns null when it declared none,
 * or none of them resolve.
 */
export function createChartCitationLine(
  numbers: number[],
  sources: ChartSource[],
  cards: StoredResultCard[] = []
): HTMLElement | null {
  const chips = numbers
    .map((number) => createInlineCitation(number, sources, cards))
    .filter((chip): chip is HTMLButtonElement => chip !== null);
  if (!chips.length) return null;

  const line = document.createElement('p');
  line.className = 'block-sources';

  const lead = document.createElement('span');
  lead.className = 'block-sources-lead';
  lead.textContent = chips.length === 1 ? 'Source' : 'Sources';
  line.appendChild(lead);
  chips.forEach((chip) => line.appendChild(chip));

  return line;
}

/**
 * Resolves a `[^n]` marker the model wrote into a clickable reference.
 *
 * Returns null for a number the turn never issued. Models do invent citation
 * numbers, and a marker that cites nothing must fall back to plain text rather
 * than become a chip pointing at the wrong observation.
 */
export function createInlineCitation(
  marker: number,
  sources: ChartSource[],
  cards: StoredResultCard[] = []
): HTMLButtonElement | null {
  const match = citationsForDisplay(sources).find(
    (entry) => entry.citation.number === marker
  );
  if (!match) return null;

  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'inline-citation';
  chip.textContent = String(marker);
  chip.title = `${match.plugin} · ${match.citation.label}`;
  chip.setAttribute('aria-label', `Source ${marker}: ${chip.title}`);
  chip.addEventListener('click', () =>
    openCitationModal(match.citation, cards[match.cardIndex ?? -1])
  );
  return chip;
}

/**
 * The citation numbers an answer actually used, in the order it used them.
 * Markers for references the turn never issued are dropped.
 */
export function citedCitationNumbers(text: string, sources: ChartSource[]): number[] {
  const issued = new Set(
    citationsForDisplay(sources)
      .map((entry) => entry.citation.number)
      .filter((number): number is number => typeof number === 'number')
  );
  if (!issued.size) return [];

  const cited: number[] = [];
  for (const match of String(text || '').matchAll(INLINE_CITATION_PATTERN)) {
    const number = Number(match[1]);
    if (issued.has(number) && !cited.includes(number)) cited.push(number);
  }
  return cited;
}

/** Whether the text cites at least one reference the turn actually issued. */
export function hasInlineCitations(text: string, sources: ChartSource[]): boolean {
  return citedCitationNumbers(text, sources).length > 0;
}

/** `[^12]`, the marker the main-agent prompt teaches the model to write. */
export const INLINE_CITATION_PATTERN = /\[\^(\d{1,3})\]/g;

function createChip(
  plugin: string,
  citation: StoredCitation,
  card?: StoredResultCard
): HTMLButtonElement {
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'block-source-chip';
  // The plugin names who served the data, the label names the dataset.
  chip.textContent = citation.label ? `${plugin} · ${citation.label}` : plugin;
  chip.title = citation.sourceUrl || citation.label;
  chip.addEventListener('click', () => openCitationModal(citation, card));
  return chip;
}

/** Opens the citation modal on one reference, showing its call's result card. */
export function openCitationModal(citation: StoredCitation, card?: StoredResultCard) {
  const host = ensureModal();
  const body = host.querySelector<HTMLElement>('.citation-modal-body');
  const title = host.querySelector<HTMLElement>('.citation-modal-title');
  const hint = host.querySelector<HTMLElement>('.citation-modal-hint');
  if (!body || !title || !hint) return;

  title.textContent = citation.label;
  hint.textContent = citation.fetchedAt ? `Fetched ${formatFetchedAt(citation.fetchedAt)}` : '';
  hint.classList.toggle('is-hidden', !hint.textContent);
  clearBody(body);

  if (citation.quote) {
    const quote = document.createElement('p');
    quote.className = 'citation-modal-quote';
    quote.textContent = citation.quote;
    body.appendChild(quote);
  }

  if (card?.template) {
    const mount = document.createElement('div');
    mount.className = 'citation-modal-card';
    body.appendChild(mount);
    // Expanded: the reader clicked the citation to see this, so a disclosure
    // would just be one more click to the same place.
    renderResultCards(mount, [card], { collapsible: false });
    cardMount = mount;
  } else if (citation.payload) {
    // No card on this call — fall back to the raw response.
    const payload = renderJson(citation.payload);
    payload.classList.add('citation-modal-payload');
    body.appendChild(payload);
    if (citation.payloadTruncated) {
      const note = document.createElement('p');
      note.className = 'citation-modal-note';
      note.textContent = 'Payload truncated. Open the API URL for the complete response.';
      body.appendChild(note);
    }
  }

  if (citation.sourceUrl) {
    const link = document.createElement('a');
    link.className = 'citation-modal-link';
    link.href = citation.sourceUrl;
    link.rel = 'noreferrer noopener';
    link.textContent = 'Open API URL';
    body.appendChild(link);
  }

  host.classList.remove('is-hidden');
  host.setAttribute('aria-hidden', 'false');
  host.querySelector<HTMLButtonElement>('.citation-modal-close')?.focus();
}

/** Empties the modal body, releasing the React root a card left behind. */
function clearBody(body: HTMLElement) {
  if (cardMount) {
    unmountResultCards(cardMount);
    cardMount = null;
  }
  body.textContent = '';
}

export function closeCitationModal() {
  if (!modal) return;
  modal.classList.add('is-hidden');
  modal.setAttribute('aria-hidden', 'true');
}

/** ISO timestamps are what the SDK stores; a reader wants a local time. */
function formatFetchedAt(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function ensureModal(): HTMLElement {
  if (modal) return modal;

  const host = document.createElement('section');
  host.className = 'citation-modal-overlay is-hidden';
  host.setAttribute('aria-hidden', 'true');
  host.innerHTML = `
    <div class="citation-modal" role="dialog" aria-modal="true" aria-labelledby="citationModalTitle">
      <header class="citation-modal-header">
        <div>
          <h2 id="citationModalTitle" class="citation-modal-title"></h2>
          <p class="citation-modal-hint"></p>
        </div>
        <button class="citation-modal-close" type="button" aria-label="Close citation">x</button>
      </header>
      <div class="citation-modal-body"></div>
    </div>
  `;

  host.addEventListener('click', (event) => {
    if (event.target === host) closeCitationModal();
  });
  host.querySelector('.citation-modal-close')?.addEventListener('click', closeCitationModal);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeCitationModal();
  });

  document.body.appendChild(host);
  modal = host;
  return host;
}

/** Test seam: drops the cached modal so each case starts from a clean DOM. */
export function resetCitationModal() {
  if (cardMount) {
    unmountResultCards(cardMount);
    cardMount = null;
  }
  modal?.remove();
  modal = null;
}
