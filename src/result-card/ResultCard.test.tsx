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
      { layout: [{ component: 'Table', columns: [{ header: 'Sym', field: 'symbol' }], rows: 'holdings' }] },
      { holdings: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }] }
    );
    expect(html).toContain('AAPL');
    expect(html).toContain('MSFT');
  });

  it('shows an empty-state row for a missing table array', () => {
    const html = render(
      { layout: [{ component: 'Table', columns: [{ header: 'Sym', field: 'symbol' }], rows: 'missing' }] },
      {}
    );
    expect(html).toContain('No rows');
  });

  it('renders nested Section blocks', () => {
    const html = render(
      {
        layout: [
          { component: 'Section', title: 'Details', layout: [{ component: 'Text', text: 'Hello {{who}}' }] }
        ]
      },
      { who: 'World' }
    );
    expect(html).toContain('Details');
    expect(html).toContain('Hello World');
  });

  it('falls back to raw JSON for an unknown component', () => {
    const html = render(
      // Intentionally invalid component to exercise the default branch.
      { layout: [{ component: 'Mystery' } as never] },
      { a: 1 }
    );
    expect(html).toContain('Mystery');
    expect(html).toContain('<pre');
  });

  it('renders an Image block as a header avatar and keeps the body', () => {
    const html = render(
      {
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
});
