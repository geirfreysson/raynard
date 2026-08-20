import { useEffect, useState } from 'react';
import { ResultCard } from './ResultCard';
import { hydrateResultCards, type ResultArtifactLoader } from './artifacts';
import { interpolate } from './resolve';
import type { StoredResultCard } from './types';

function cardName(card: StoredResultCard): { singular: string; plural: string } {
  return {
    singular: card.template.name.singular.trim(),
    plural: card.template.name.plural.trim()
  };
}

export function cardCountLabel(cards: StoredResultCard[]): string {
  const groups = new Map<string, { count: number; singular: string; plural: string }>();
  for (const card of cards) {
    const name = cardName(card);
    const key = `${name.singular}\u0000${name.plural}`;
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      groups.set(key, { count: 1, ...name });
    }
  }
  return [...groups.values()]
    .map(({ count, singular, plural }) => `${count} ${count === 1 ? singular : plural}`)
    .join(' · ');
}

/**
 * Distinct extension names behind these cards, in first-seen order. Empty when
 * any card is unattributed: a half-resolved mix would silently under-report
 * where the numbers came from, so it falls back to the per-kind breakdown.
 */
function cardPlugins(cards: StoredResultCard[]): string[] {
  const names: string[] = [];
  for (const card of cards) {
    const name = (card.plugin || '').trim();
    if (!name) return [];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * The disclosure summary. One extension keeps the per-kind breakdown
 * (`1 indicator · 5 observations`); two or more name the extensions instead,
 * because merged counts hide which source each number came from.
 */
export function cardSummaryLabel(cards: StoredResultCard[]): string {
  const plugins = cardPlugins(cards);
  if (plugins.length < 2) return cardCountLabel(cards);
  const noun = cards.length === 1 ? 'result' : 'results';
  return `${cards.length} ${noun} from ${plugins.join(' · ')}`;
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : 'Result';
}

export function cardItemLabel(card: StoredResultCard, index = 0): string {
  const kind = capitalize(cardName(card).singular);
  const title = card.template.title ? interpolate(card.template.title, card.data).trim() : '';
  return title ? `${kind}: ${title}` : `${kind} ${index + 1}`;
}

function ResultCardDisclosure({ card, index }: { card: StoredResultCard; index: number }) {
  const [open, setOpen] = useState(false);
  const label = cardItemLabel(card, index);

  return (
    <div role="listitem">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex w-full items-center gap-1.5 bg-transparent py-1.5 text-left text-[15px] font-normal leading-[1.55] text-muted-foreground transition-colors hover:text-foreground"
      >
        <svg
          className={`h-3.5 w-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span>{label}</span>
      </button>
      {open && <div className="mt-1"><ResultCard template={card.template} data={card.data} cached={card.cached} /></div>}
    </div>
  );
}

export function ResultCardList({ cards }: { cards: StoredResultCard[] }) {
  const plugins = cardPlugins(cards);

  // One source (or none we can name) reads better as a plain sequence.
  if (plugins.length < 2) {
    return (
      <div role="list" className="flex flex-col gap-0.5">
        {cards.map((card, index) => (
          <ResultCardDisclosure key={index} card={card} index={index} />
        ))}
      </div>
    );
  }

  // Indices stay message-wide so an untitled card keeps one stable number.
  return (
    <div role="list" className="flex flex-col gap-0.5">
      {plugins.map((plugin) => (
        <div key={plugin} role="group" aria-label={plugin}>
          <p className="px-0 pt-2 pb-0.5 text-[13px] font-medium text-muted-foreground">
            {plugin}
          </p>
          {cards.map((card, index) =>
            (card.plugin || '').trim() === plugin ? (
              <ResultCardDisclosure key={index} card={card} index={index} />
            ) : null
          )}
        </div>
      ))}
    </div>
  );
}

// Cards are collapsed behind a small disclosure by default (like references in
// northfox-frontend) so they don't dominate the transcript — click to reveal.
// The plugin-detail preview passes collapsible={false} to always show them.
export function ResultCardStack({
  cards,
  collapsible = true,
  loadArtifact
}: {
  cards: StoredResultCard[];
  collapsible?: boolean;
  loadArtifact?: ResultArtifactLoader;
}) {
  const [open, setOpen] = useState(false);
  const [hydrated, setHydrated] = useState(cards);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const shouldLoad = !collapsible || open;

  useEffect(() => {
    let active = true;
    setHydrated(cards);
    setLoadError('');
    if (!shouldLoad || !loadArtifact || !cards.some((card) => card.artifact)) {
      setLoading(false);
      return () => {
        active = false;
      };
    }
    setLoading(true);
    void hydrateResultCards(cards, loadArtifact).then(
      (next) => {
        if (!active) return;
        setHydrated(next);
        setLoading(false);
      },
      (error) => {
        if (!active) return;
        setLoadError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      }
    );
    return () => {
      active = false;
    };
  }, [cards, cards.length, loadArtifact, shouldLoad]);

  const valid = Array.isArray(hydrated)
    ? hydrated.filter((card) => card && card.template)
    : [];
  if (!valid.length) return null;

  const stack = (
    <div className="flex flex-col gap-2">
      {valid.map((card, i) => (
        <ResultCard key={i} template={card.template} data={card.data} cached={card.cached} />
      ))}
    </div>
  );

  if (!collapsible) {
    return (
      <div className="rc-scope">
        {loading ? <p className="text-sm text-muted-foreground">Loading result…</p> : null}
        {loadError ? <p className="text-sm text-destructive">Could not load result.</p> : null}
        {!loading && !loadError ? stack : null}
      </div>
    );
  }

  const label = cardSummaryLabel(valid);
  return (
    <div className="rc-scope">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-2.5 py-1 text-[15px] font-normal leading-[1.55] text-muted-foreground shadow-sm transition-colors hover:bg-muted hover:text-foreground"
      >
        <svg
          className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="m9 18 6-6-6-6" />
        </svg>
        <span>{label}</span>
      </button>
      {open && loading ? <p className="mt-2 text-sm text-muted-foreground">Loading results…</p> : null}
      {open && loadError ? <p className="mt-2 text-sm text-destructive">Could not load results.</p> : null}
      {open && !loading && !loadError ? <div className="mt-2"><ResultCardList cards={valid} /></div> : null}
    </div>
  );
}
