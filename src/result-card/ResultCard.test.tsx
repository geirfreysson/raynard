import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { ResultCard } from './ResultCard';
import type { CardTemplate } from './types';

function render(template: CardTemplate, data: unknown): string {
  return renderToStaticMarkup(createElement(ResultCard, { template, data }));
}

describe('ResultCard', () => {
  it('interpolates the title and binds MetricRow / KeyValue fields', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        title: '{{name}} (#{{id}})',
        layout: [
          { component: 'MetricRow', items: [{ label: 'Price', field: 'price', tone: 'delta' }] },
          { component: 'KeyValue', pairs: [{ label: 'Category', field: 'category' }] }
        ]
      },
      { id: 3, name: 'Widget', price: '182.50', category: 'Tools' }
    );
    expect(html).toContain('Widget (#3)');
    expect(html).toContain('182.50');
    expect(html).toContain('Category');
    expect(html).toContain('Tools');
  });

  it('renders a Table from a rows path', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        layout: [{ component: 'Table', columns: [{ header: 'Sym', field: 'symbol' }], rows: 'holdings' }]
      },
      { holdings: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }] }
    );
    expect(html).toContain('AAPL');
    expect(html).toContain('MSFT');
  });

  it('shows an empty-state row for a missing table array', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        layout: [{ component: 'Table', columns: [{ header: 'Sym', field: 'symbol' }], rows: 'missing' }]
      },
      {}
    );
    expect(html).toContain('No rows');
  });

  it('renders nested Section blocks', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        layout: [
          { component: 'Section', title: 'Details', layout: [{ component: 'Text', text: 'Hello {{who}}' }] }
        ]
      },
      { who: 'World' }
    );
    expect(html).toContain('Details');
    expect(html).toContain('Hello World');
  });

  it('renders an Image block as a header avatar and keeps the body', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        title: '{{name}}',
        layout: [
          { component: 'Image', field: 'img', alt: '{{name}} portrait' },
          { component: 'KeyValue', pairs: [{ label: 'Type', field: 'type' }] }
        ]
      },
      { name: 'Orc', img: 'https://example.com/orc.png', type: 'Humanoid' }
    );
    // Header title + avatar fallback (image loads client-side; SSR shows initials).
    expect(html).toContain('Orc');
    // Body block still rendered.
    expect(html).toContain('Type');
    expect(html).toContain('Humanoid');
  });

  it('renders a 3:1 Columns layout with a right-side media image', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        title: '{{name}}',
        layout: [
          {
            component: 'Columns',
            columns: [
              {
                width: 3,
                layout: [{ component: 'Text', text: '{{description}}' }]
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
        description: 'A large and dangerous creature.',
        image: 'https://example.com/owlbear.png'
      }
    );

    expect(html).toContain('rc-columns');
    expect(html).toContain('grid-template-columns:3fr 1fr');
    expect(html).toContain('rc-media-image');
    expect(html).toContain('aspect-ratio:3 / 4');
    expect(html).toContain('object-fit:cover');
    expect(html).toContain('src="https://example.com/owlbear.png"');
  });

  it('renders nested Grid and Stack layout primitives', () => {
    const html = render(
      {
        name: { singular: 'result', plural: 'results' },
        layout: [
          {
            component: 'Grid',
            columns: 2,
            gap: 'lg',
            layout: [
              {
                component: 'Stack',
                gap: 'sm',
                layout: [
                  { component: 'Badge', field: 'type' },
                  { component: 'Text', text: '{{description}}' }
                ]
              }
            ]
          }
        ]
      },
      { type: 'Monstrosity', description: 'Feathered fury.' }
    );

    expect(html).toContain('rc-grid');
    expect(html).toContain('grid-template-columns:repeat(2, minmax(0, 1fr))');
    expect(html).toContain('rc-stack');
    expect(html).toContain('Feathered fury.');
  });
});
