import { describe, expect, it } from 'vitest';

import { collectTemplateFields, interpolationPaths } from './template-fields';
import type { CardBlock, CardTemplate } from './types';

// Every `CardBlock` variant. Adding one to `types.ts` without handling it in
// `collectTemplateFields` is already a compile error (the `never` assertion in
// its default branch); this list makes it a test failure too, so the coverage
// below cannot quietly stop being exhaustive.
const ALL_COMPONENTS = [
  'MetricRow',
  'Table',
  'KeyValue',
  'Text',
  'Section',
  'Stack',
  'Grid',
  'Columns',
  'Badge',
  'Image',
  'Json'
] as const;

const name = { singular: 'monster', plural: 'monsters' };

function template(layout: CardBlock[], title?: string): CardTemplate {
  return title ? { name, title, layout } : { name, layout };
}

describe('interpolationPaths', () => {
  it('reads every token, trimming whitespace inside the braces', () => {
    expect(interpolationPaths('{{ a.b }} and {{c}}')).toEqual(['a.b', 'c']);
  });

  it('returns nothing for a plain string', () => {
    expect(interpolationPaths('no tokens here')).toEqual([]);
    expect(interpolationPaths('')).toEqual([]);
  });
});

describe('collectTemplateFields', () => {
  it('covers every block variant', () => {
    const layout: CardBlock[] = [
      { component: 'MetricRow', items: [{ label: 'HP', field: 'hp' }] },
      { component: 'Table', columns: [{ header: 'Name', field: 'n' }], rows: 'list' },
      { component: 'KeyValue', pairs: [{ label: 'AC', field: 'ac' }] },
      { component: 'Text', text: 'A {{size}} creature' },
      { component: 'Section', title: 'Stats', layout: [{ component: 'Badge', field: 'cr' }] },
      { component: 'Stack', layout: [{ component: 'Json', field: 'raw' }] },
      { component: 'Grid', layout: [{ component: 'Image', field: 'img', alt: '{{alt.text}}' }] },
      {
        component: 'Columns',
        columns: [{ layout: [{ component: 'KeyValue', pairs: [{ label: 'Speed', field: 'spd' }] }] }]
      }
    ];

    const seen = new Set<string>();
    const walk = (blocks: CardBlock[]) => {
      for (const block of blocks) {
        seen.add(block.component);
        if ('layout' in block && Array.isArray(block.layout)) walk(block.layout);
        if (block.component === 'Columns') {
          for (const column of block.columns) walk(column.layout);
        }
      }
    };
    walk(layout);
    expect([...seen].sort()).toEqual([...ALL_COMPONENTS].sort());

    const { fields, tables, wholeData } = collectTemplateFields(template(layout, '{{title}}'));
    expect(fields.map((field) => field.path)).toEqual([
      'title',
      'hp',
      'ac',
      'size',
      'cr',
      'raw',
      'img',
      'alt.text',
      'spd'
    ]);
    expect(tables).toEqual([{ rows: 'list', columns: ['n'], wholeRow: false }]);
    expect(wholeData).toBe(false);
  });

  it('marks a MetricRow delta item so a placeholder can look like a delta', () => {
    const { fields } = collectTemplateFields(
      template([
        {
          component: 'MetricRow',
          items: [
            { label: 'Change', field: 'chg', tone: 'delta' },
            { label: 'Price', field: 'px' }
          ]
        }
      ])
    );
    expect(fields).toEqual([
      { path: 'chg', kind: 'delta' },
      { path: 'px', kind: 'value' }
    ]);
  });

  it('tags image and json fields by kind', () => {
    const { fields } = collectTemplateFields(
      template([
        { component: 'Image', field: 'avatar' },
        { component: 'Json', field: 'raw' }
      ])
    );
    expect(fields).toEqual([
      { path: 'avatar', kind: 'image' },
      { path: 'raw', kind: 'json' }
    ]);
  });

  it('collects the interpolated Image alt, which the renderer resolves', () => {
    const { fields } = collectTemplateFields(
      template([{ component: 'Image', field: 'img', alt: '{{monster.name}}' }])
    );
    expect(fields.map((field) => field.path)).toContain('monster.name');
  });

  it('ignores labels the renderer prints literally', () => {
    // Section titles, table headers, metric labels and key-value labels are all
    // rendered verbatim, so they bind no data.
    const { fields, tables } = collectTemplateFields(
      template([
        {
          component: 'Section',
          title: '{{not.interpolated}}',
          layout: [
            { component: 'Table', columns: [{ header: '{{also.not}}', field: 'n' }], rows: 'rows' },
            { component: 'MetricRow', items: [{ label: '{{nope}}', field: 'v' }] }
          ]
        }
      ])
    );
    expect(fields.map((field) => field.path)).toEqual(['v']);
    expect(tables[0].columns).toEqual(['n']);
  });

  it('flags a fieldless Json block as unprojectable', () => {
    expect(collectTemplateFields(template([{ component: 'Json' }])).wholeData).toBe(true);
    expect(collectTemplateFields(template([{ component: 'Json', field: 'x' }])).wholeData).toBe(
      false
    );
  });

  it('flags a table column bound to the whole row', () => {
    const { tables } = collectTemplateFields(
      template([
        { component: 'Table', columns: [{ header: 'Raw', field: '' }], rows: 'rows' }
      ])
    );
    expect(tables).toEqual([{ rows: 'rows', columns: [], wholeRow: true }]);
  });

  it('recurses through nested containers', () => {
    const { fields } = collectTemplateFields(
      template([
        {
          component: 'Stack',
          layout: [
            {
              component: 'Grid',
              layout: [
                {
                  component: 'Columns',
                  columns: [
                    { layout: [{ component: 'Section', layout: [{ component: 'Badge', field: 'deep' }] }] }
                  ]
                }
              ]
            }
          ]
        }
      ])
    );
    expect(fields.map((field) => field.path)).toEqual(['deep']);
  });

  it('keeps the first binding when a path repeats', () => {
    const { fields } = collectTemplateFields(
      template([
        { component: 'MetricRow', items: [{ label: 'A', field: 'v', tone: 'delta' }] },
        { component: 'Badge', field: 'v' }
      ])
    );
    expect(fields).toEqual([{ path: 'v', kind: 'delta' }]);
  });

  it('skips a table with no rows path and drops empty layouts safely', () => {
    const { fields, tables } = collectTemplateFields(
      template([
        { component: 'Table', columns: [{ header: 'N', field: 'n' }], rows: '' },
        { component: 'Stack', layout: [] }
      ])
    );
    expect(tables).toEqual([]);
    expect(fields).toEqual([]);
  });
});
