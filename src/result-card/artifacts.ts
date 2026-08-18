import type { ResultArtifactRef, StoredResultCard } from './types';

export type ResultArtifactLoader = (artifact: ResultArtifactRef) => Promise<unknown>;

/** Hydrate only the cards whose large data was externalized by the host. */
export async function hydrateResultCards(
  cards: StoredResultCard[],
  load: ResultArtifactLoader
): Promise<StoredResultCard[]> {
  return Promise.all(
    cards.map(async (card) => {
      if (!card.artifact) return card;
      const data = await load(card.artifact);
      return { ...card, data };
    })
  );
}
