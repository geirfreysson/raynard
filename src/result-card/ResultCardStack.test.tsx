import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ResultCardList, ResultCardStack, cardItemLabel } from './ResultCardStack';
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

  it('labels each gathered card with its kind and resolved title', () => {
    expect(cardItemLabel(card)).toBe('Monster: Orc');

    const observation: StoredResultCard = {
      toolName: 'data360_get_data',
      template: {
        name: { singular: 'observation', plural: 'observations' },
        title: 'Data360 observations — {{indicatorId}}',
        layout: [{ component: 'Text', text: '{{value}}' }]
      },
      data: { indicatorId: 'WB_WDI_SP_POP_TOTL', value: '8.1 billion' }
    };
    expect(cardItemLabel(observation)).toBe(
      'Observation: Data360 observations — WB_WDI_SP_POP_TOTL'
    );
  });

  it('shows named item disclosures without expanding every card body', () => {
    const html = renderToStaticMarkup(
      createElement(ResultCardList, { cards: [card, { ...card, data: { name: 'Goblin', type: 'Humanoid' } }] })
    );
    expect(html).toContain('Monster: Orc');
    expect(html).toContain('Monster: Goblin');
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html.match(/bg-transparent/g)).toHaveLength(2);
    expect(html).not.toContain('Humanoid');
  });

  it('renders the card directly when not collapsible (preview)', () => {
    const html = render(false);
    expect(html).toContain('Orc');
    expect(html).toContain('Humanoid');
    expect(html).not.toContain('aria-expanded');
  });
});
