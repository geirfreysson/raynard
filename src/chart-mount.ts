import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChartBlock } from './components/ui/chart';
import type { ChartSpec } from './chart-spec';
import './result-card/theme.css';

// Vanilla DOM <-> React bridge for ```chart fences, mirroring
// src/result-card/mount.ts. Each chart container keeps one React root in a
// WeakMap so a re-render reuses it instead of rebuilding the tree.

const roots = new WeakMap<HTMLElement, Root>();

/** Render (or re-render) a parsed chart spec into a container. */
export function renderChart(container: HTMLElement, spec: ChartSpec): void {
  let root = roots.get(container);
  if (!root) {
    root = createRoot(container);
    roots.set(container, root);
  }
  root.render(createElement(ChartBlock, { spec }));
}

/** Tear down a chart container's React root before its DOM node is discarded. */
export function unmountChart(container: HTMLElement): void {
  const root = roots.get(container);
  if (root) {
    root.unmount();
    roots.delete(container);
  }
}
