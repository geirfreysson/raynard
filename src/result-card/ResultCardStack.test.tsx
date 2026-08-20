import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import {
  ResultCardList,
  ResultCardStack,
  cardItemLabel,
  cardSummaryLabel
} from './ResultCardStack';
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

  it('keeps the per-kind breakdown when every card comes from one extension', () => {
    const oecd = { ...card, plugin: 'OECD Data Explorer' };
    const dataflow: StoredResultCard = {
      toolName: 'oecd_get_dataflow',
      plugin: 'OECD Data Explorer',
      template: {
        name: { singular: 'dataflow', plural: 'dataflows' },
        layout: [{ component: 'Text', text: '{{name}}' }]
      },
      data: { name: 'DF_MIG' }
    };
    expect(cardSummaryLabel([oecd, dataflow])).toBe('1 monster · 1 dataflow');
  });

  it('names the extensions instead of the kinds when an answer spans two of them', () => {
    const oecd = { ...card, plugin: 'OECD Data Explorer' };
    const worldBank: StoredResultCard = {
      toolName: 'data360_get_data',
      plugin: 'World Bank Data360',
      template: {
        name: { singular: 'observation', plural: 'observations' },
        layout: [{ component: 'Text', text: '{{value}}' }]
      },
      data: { value: '1' }
    };
    expect(cardSummaryLabel([oecd, worldBank, worldBank])).toBe(
      '3 results from OECD Data Explorer · World Bank Data360'
    );
    const html = renderToStaticMarkup(
      createElement(ResultCardStack, {
        cards: [oecd, worldBank, worldBank],
        collapsible: true
      })
    );
    expect(html).toContain('3 results from OECD Data Explorer · World Bank Data360');
  });

  it('falls back to the per-kind breakdown when a card has no known extension', () => {
    const attributed = { ...card, plugin: 'OECD Data Explorer' };
    expect(cardSummaryLabel([attributed, card])).toBe('2 monsters');
  });

  it('groups the expanded list under one heading per extension, and only then', () => {
    const oecd = { ...card, plugin: 'OECD Data Explorer' };
    const worldBank: StoredResultCard = {
      toolName: 'data360_get_data',
      plugin: 'World Bank Data360',
      template: {
        name: { singular: 'observation', plural: 'observations' },
        title: 'Net migration',
        layout: [{ component: 'Text', text: '{{value}}' }]
      },
      data: { value: '1' }
    };

    const grouped = renderToStaticMarkup(
      createElement(ResultCardList, { cards: [oecd, worldBank] })
    );
    expect(grouped).toContain('OECD Data Explorer');
    expect(grouped).toContain('World Bank Data360');
    expect(grouped).toContain('aria-label="OECD Data Explorer"');
    // Item numbering stays message-wide, so the second card is not "Observation 1".
    expect(grouped).toContain('Observation: Net migration');

    const flat = renderToStaticMarkup(
      createElement(ResultCardList, { cards: [oecd, { ...oecd, data: { name: 'Goblin' } }] })
    );
    expect(flat).not.toContain('role="group"');
    expect(flat).not.toContain('OECD Data Explorer');
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
