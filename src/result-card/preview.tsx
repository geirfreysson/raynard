// Dev-only visual preview of result cards, rendered in isolation (no Tauri).
// Served by Vite at /card-preview.html.
import { renderResultCards } from './mount';
import type { CardTemplate } from './types';

const app = document.getElementById('app')!;

function add(label: string, template: CardTemplate, data: unknown, collapsible = false) {
  const h = document.createElement('h2');
  h.textContent = label;
  app.appendChild(h);
  const div = document.createElement('div');
  app.appendChild(div);
  renderResultCards(div, [{ toolName: 'preview', template, data }], { collapsible });
}

add(
  'Collapsed by default (chat) — click to reveal',
  {
    name: { singular: 'monster', plural: 'monsters' },
    title: '{{name}}',
    layout: [
      { component: 'Image', field: 'image', alt: '{{name}}' },
      { component: 'KeyValue', pairs: [{ label: 'Type', field: 'type' }] }
    ]
  },
  { name: 'Goblin', image: 'https://www.dnd5eapi.co/api/images/monsters/goblin.png', type: 'Humanoid (goblinoid)' },
  true
);

add(
  'Monster (image → header avatar)',
  {
    name: { singular: 'monster', plural: 'monsters' },
    title: '{{name}}',
    layout: [
      { component: 'Image', field: 'image', alt: '{{name}}' },
      { component: 'Badge', field: 'alignment', tone: 'muted' },
      { component: 'MetricRow', items: [
        { label: 'AC', field: 'ac' },
        { label: 'HP', field: 'hp' },
        { label: 'CR', field: 'cr' },
        { label: 'Speed', field: 'speed' }
      ] },
      { component: 'KeyValue', pairs: [
        { label: 'Type', field: 'type' },
        { label: 'Size', field: 'size' }
      ] },
      { component: 'Table', columns: [
        { header: 'Ability', field: 'k' },
        { header: 'Score', field: 'v' }
      ], rows: 'stats' }
    ]
  },
  {
    name: 'Orc',
    image: 'https://www.dnd5eapi.co/api/images/monsters/orc.png',
    alignment: 'Chaotic Evil',
    ac: '13',
    hp: '15 (2d8+2)',
    cr: '1/2',
    speed: '30 ft.',
    type: 'Humanoid (orc)',
    size: 'Medium',
    stats: [
      { k: 'STR', v: '16' }, { k: 'DEX', v: '12' }, { k: 'CON', v: '13' },
      { k: 'INT', v: '7' }, { k: 'WIS', v: '11' }, { k: 'CHA', v: '10' }
    ]
  }
);

add(
  'Monster detail (75% content + 25% right-side image)',
  {
    name: { singular: 'monster', plural: 'monsters' },
    title: '{{name}}',
    layout: [
      {
        component: 'Columns',
        gap: 'lg',
        columns: [
          {
            width: 3,
            layout: [
              {
                component: 'Stack',
                gap: 'md',
                layout: [
                  { component: 'Badge', field: 'type', tone: 'muted' },
                  {
                    component: 'MetricRow',
                    items: [
                      { label: 'AC', field: 'ac' },
                      { label: 'HP', field: 'hp' },
                      { label: 'CR', field: 'cr' }
                    ]
                  },
                  { component: 'Text', text: '{{description}}' }
                ]
              }
            ]
          },
          {
            width: 1,
            layout: [
              {
                component: 'Image',
                field: 'image',
                alt: '{{name}}',
                variant: 'media',
                aspectRatio: '3/4',
                fit: 'cover'
              }
            ]
          }
        ]
      }
    ]
  },
  {
    name: 'Owlbear',
    type: 'Monstrosity',
    ac: '13',
    hp: '59 (7d10+21)',
    cr: '3',
    description: 'A hulking predator with the body of a bear and the head of an owl.',
    image: 'https://www.dnd5eapi.co/api/images/monsters/owlbear.png'
  }
);

add(
  'Metrics + delta',
  {
    name: { singular: 'stock', plural: 'stocks' },
    title: '{{symbol}} — {{name}}',
    layout: [
      { component: 'MetricRow', items: [
        { label: 'Price', field: 'price' },
        { label: 'Change', field: 'change', tone: 'delta' },
        { label: 'Volume', field: 'volume', tone: 'muted' }
      ] },
      { component: 'KeyValue', pairs: [{ label: 'Market cap', field: 'cap' }] }
    ]
  },
  { symbol: 'AAPL', name: 'Apple Inc.', price: '$182.50', change: '+1.24%', volume: '48.2M', cap: '$2.8T' }
);
