import { describe, expect, it } from 'vitest';
import { buildExampleData } from './example';
import { getPath, resolveRows, interpolate } from './resolve';
import type { CardTemplate } from './types';

describe('buildExampleData', () => {
  it('fills every path a template binds to so the card renders non-empty', () => {
    const template: CardTemplate = {
      title: '{{name}} (#{{id}})',
      layout: [
        { component: 'MetricRow', items: [
          { label: 'HP', field: 'stats.hp' },
          { label: 'Change', field: 'change', tone: 'delta' }
        ] },
        { component: 'KeyValue', pairs: [{ label: 'Type', field: 'type' }] },
        { component: 'Table', columns: [{ header: 'Spell', field: 'spell.name' }], rows: 'spells' },
        { component: 'Text', text: 'About {{name}}' },
        { component: 'Badge', field: 'rarity' }
      ]
    };

    const data = buildExampleData(template);

    // Title + text interpolation resolve.
    expect(interpolate('{{name}} (#{{id}})', data)).not.toContain('{{');
    expect(getPath(data, 'name')).toBeTruthy();
    // Nested metric path is populated.
    expect(getPath(data, 'stats.hp')).toBeTruthy();
    // Delta metric looks like a signed percentage.
    expect(String(getPath(data, 'change'))).toMatch(/[+-]/);
    // Table rows exist as an array with the column field on each row.
    const rows = resolveRows(data, 'spells');
    expect(rows.length).toBeGreaterThan(0);
    expect(getPath(rows[0], 'spell.name')).toBeTruthy();
    // Badge + key-value fields populated.
    expect(getPath(data, 'rarity')).toBeTruthy();
    expect(getPath(data, 'type')).toBeTruthy();
  });

  it('recurses into Section blocks', () => {
    const template: CardTemplate = {
      layout: [{ component: 'Section', title: 'More', layout: [{ component: 'KeyValue', pairs: [{ label: 'CR', field: 'meta.cr' }] }] }]
    };
    const data = buildExampleData(template);
    expect(getPath(data, 'meta.cr')).toBeTruthy();
  });

  it('handles an empty template without throwing', () => {
    expect(buildExampleData({ layout: [] })).toEqual({});
  });
});
