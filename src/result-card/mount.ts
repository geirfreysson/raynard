import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ResultCardStack } from './ResultCardStack';
import type { ResultArtifactLoader } from './artifacts';
import type { StoredResultCard } from './types';
import './theme.css';
import './result-card.css';

// Vanilla DOM ↔ React bridge. Each message keeps one card container whose React
// root is reused across re-renders so live streaming (new cards arriving mid
// turn) doesn't tear down and rebuild the tree.

const roots = new WeakMap<HTMLElement, Root>();
let artifactLoader: ResultArtifactLoader | undefined;

/** Installed once by the Tauri host; previews and unit tests can omit it. */
export function configureResultArtifactLoader(loader: ResultArtifactLoader): void {
  artifactLoader = loader;
}

/**
 * Render (or re-render) the given cards into a container under a message.
 * Collapsed behind a disclosure by default; pass { collapsible: false } (e.g. the
 * plugin-detail preview) to always show the cards expanded.
 */
export function renderResultCards(
  container: HTMLElement,
  cards: StoredResultCard[],
  options: { collapsible?: boolean } = {}
): void {
  const valid = Array.isArray(cards) ? cards.filter((card) => card && card.template) : [];
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(
    createElement(ResultCardStack, {
      cards: valid,
      collapsible: options.collapsible !== false,
      loadArtifact: artifactLoader
    })
  );
}

/** Tear down a container's React root (e.g. when clearing the transcript). */
export function unmountResultCards(container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
}
