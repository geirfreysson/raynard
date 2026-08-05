import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ResultCardStack } from './ResultCardStack';
import type { StoredResultCard } from './types';

const card: StoredResultCard = {
  toolName: 'get_monster',
  template: {
    name: { singular: 'monster', plural: 'monsters' },
    title: '{{name}}',
    layout: [{ component: 'KeyValue', pairs: [{ label: 'Type', field: 'type' }] }]
  },
  data: { name: 'Orc', type: 'Humanoid' }
};

function render(collapsible: boolean): string {
  return renderToStaticMarkup(createElement(ResultCardStack, { cards: [card], collapsible }));
}

describe('ResultCardStack', () => {
  it('is collapsed by default: shows the named count and hides the card body', () => {
    const html = render(true);
    expect(html).toContain('1 monster');
    expect(html).toContain('aria-expanded="false"');
    // The card body is not rendered until expanded.
    expect(html).not.toContain('Orc');
    expect(html).not.toContain('Humanoid');
  });

  it('groups gathered cards by their plugin-authored singular and plural names', () => {
    const resource: StoredResultCard = {
      toolName: 'get_resource',
      template: {
        name: { singular: 'resource', plural: 'resources' },
        layout: [{ component: 'Text', text: '{{name}}' }]
      },
      data: { name: 'Rope' }
    };
    const html = renderToStaticMarkup(
      createElement(ResultCardStack, { cards: [card, resource, resource], collapsible: true })
    );
    expect(html).toContain('1 monster · 2 resources');
  });

  it('falls back to card/cards for templates created before named cards', () => {
    const legacy: StoredResultCard = {
      toolName: 'get_legacy',
      template: { layout: [{ component: 'Text', text: 'Legacy' }] },
      data: {}
    };
    const html = renderToStaticMarkup(
      createElement(ResultCardStack, { cards: [legacy, legacy], collapsible: true })
    );
    expect(html).toContain('2 cards');
  });

  it('renders the card directly when not collapsible (preview)', () => {
    const html = render(false);
    expect(html).toContain('Orc');
    expect(html).toContain('Humanoid');
    expect(html).not.toContain('aria-expanded');
  });
});
