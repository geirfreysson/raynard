import { useState } from 'react';
import { ResultCard } from './ResultCard';
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

// Cards are collapsed behind a small disclosure by default (like references in
// northfox-frontend) so they don't dominate the transcript — click to reveal.
// The plugin-detail preview passes collapsible={false} to always show them.
export function ResultCardStack({
  cards,
  collapsible = true
}: {
  cards: StoredResultCard[];
  collapsible?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const valid = Array.isArray(cards) ? cards.filter((card) => card && card.template) : [];
  if (!valid.length) return null;

  const stack = (
    <div className="flex flex-col gap-2">
      {valid.map((card, i) => (
        <ResultCard key={i} template={card.template} data={card.data} />
      ))}
    </div>
  );

  if (!collapsible) {
    return <div className="rc-scope">{stack}</div>;
  }

  const label = cardCountLabel(valid);
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
      {open && <div className="mt-2">{stack}</div>}
    </div>
  );
}
