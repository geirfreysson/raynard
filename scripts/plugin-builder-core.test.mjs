import { describe, expect, it } from 'vitest';
import {
  buildTargetedPluginSnapshot,
  buildSystemPrompt,
  buildUserPrompt,
  findPluginTestFiles,
  validatePluginArtifacts
} from './plugin-builder-core.mjs';

describe('plugin builder core', () => {
  it('requires test-first API tools, broad endpoint coverage, and references', () => {
    const prompt = buildSystemPrompt({
      sourceUrls: ['https://github.com/HackerNews/API']
    });

    expect(prompt).toContain('Work test-first');
    expect(prompt).toContain('Endpoint Inventory');
    expect(prompt).toContain('createApiReference');
    expect(prompt).toContain('Do not build React components');
    expect(prompt).toContain("name: { singular: 'thing', plural: 'things' }");
    expect(prompt).toMatch(/name.*REQUIRED.*lower-case count nouns/i);
  });

  it('embeds a canonical tool template that pins the execute method and tool shape', () => {
    const prompt = buildSystemPrompt({ sourceUrls: [] });

    expect(prompt).toContain('Canonical shape');
    expect(prompt).toContain('async execute(args');
    expect(prompt).toContain('export const tools = {');
    expect(prompt).toContain('tools[name].execute(args)');
    expect(prompt).toContain('MUST be named exactly "execute"');
    expect(prompt).toContain('Never use "handler"');
  });

  it('directs the builder to reuse the vendored runtime instead of re-implementing plumbing', () => {
    const prompt = buildSystemPrompt({ sourceUrls: [] });

    expect(prompt).toContain('./runtime.ts');
    expect(prompt).toContain('apiGet');
    expect(prompt).toContain('mockFetch');
    expect(prompt).toContain('./testing.ts');
    expect(prompt).toMatch(/MUST NOT edit or re-implement/);
  });

  it('maps natural-language card requests to composable host primitives and reports capability gaps', () => {
    const prompt = buildSystemPrompt({ editMode: true, name: 'dnd-5e-api' });

    expect(prompt).toContain('Columns');
    expect(prompt).toContain('Grid');
    expect(prompt).toContain('Stack');
    expect(prompt).toMatch(/right.*25%|3:1/i);
    expect(prompt).toContain("variant: 'media'");
    expect(prompt).toContain('HOST_CAPABILITY_REQUIRED:');
    expect(prompt).toMatch(/do not invent/i);
  });

  it('gives card edits a direct recipe and focused workflow', () => {
    const prompt = buildSystemPrompt({
      editMode: true,
      taskKind: 'card-edit',
      targetTools: ['dnd_get_monster']
    });

    expect(prompt).toMatch(/CARD-EDIT FAST PATH/);
    expect(prompt).toContain('dnd_get_monster');
    expect(prompt).toMatch(/3.*1.*75%.*25%/);
    expect(prompt).toContain("variant: 'media'");
    expect(prompt).toContain("fit: 'contain'");
    expect(prompt).toMatch(/long.*Section.*full.width/i);
    expect(prompt).toMatch(/do not reread unrelated files/i);
    expect(prompt).toContain('HOST_RUNTIME_OUTDATED:');
  });

  it('builds a targeted card snapshot beyond the general source cap', () => {
    const filler = `const filler = '${'x'.repeat(17000)}';\n`;
    const toolsSource = `${filler}
export const tools = {
  unrelated_tool: {
    description: 'Unrelated',
    card: { layout: [{ component: 'Text', text: 'Nope' }] }
  },
  dnd_get_monster: {
    description: 'Monster detail',
    card: {
      title: '{{name}}',
      layout: [{ component: 'Image', field: 'image_url' }]
    },
    async execute() { return { text: 'monster', references: [], data: { image_url: 'x' } }; }
  }
};`;
    const testSource = `
test('unrelated tool works', () => tools.unrelated_tool.execute({}));
test('dnd_get_monster card layout', () => {
  assert.equal(tools.dnd_get_monster.card.layout[0].component, 'Image');
});`;
    const runtimeSource = `
export type CardBlock =
  | { component: 'Columns'; columns: { width?: number; layout: CardBlock[] }[] }
  | { component: 'Image'; field: string; variant?: 'avatar' | 'media' };
export type CardTemplate = { title?: string; layout: CardBlock[] };
export type UnrelatedRuntimeType = { ignored: true };`;

    const snapshot = buildTargetedPluginSnapshot({
      files: {
        'tools.ts': toolsSource,
        'tools.test.ts': testSource,
        'runtime.ts': runtimeSource,
        'README.md': 'Unrelated documentation'
      },
      taskKind: 'card-edit',
      targetTools: ['dnd_get_monster']
    });

    expect(snapshot).toContain('TARGETED CARD-EDIT SNAPSHOT');
    expect(snapshot).toContain('dnd_get_monster');
    expect(snapshot).toContain("title: '{{name}}'");
    expect(snapshot).toContain("test('dnd_get_monster card layout'");
    expect(snapshot).toContain('export type CardBlock');
    expect(snapshot).toContain('export type CardTemplate');
    expect(snapshot).not.toContain('const filler');
    expect(snapshot).not.toContain("test('unrelated tool works'");
    expect(snapshot).not.toContain('UnrelatedRuntimeType');
    expect(snapshot).not.toContain('Unrelated documentation');
  });

  it('falls back when a targeted tool cannot be resolved', () => {
    expect(
      buildTargetedPluginSnapshot({
        files: { 'tools.ts': 'export const tools = { known: {} };' },
        taskKind: 'card-edit',
        targetTools: ['missing_tool']
      })
    ).toBeNull();
    expect(
      buildTargetedPluginSnapshot({
        files: { 'tools.ts': 'export const tools = { known: {} };' },
        taskKind: 'plugin-edit',
        targetTools: ['known']
      })
    ).toBeNull();
  });

  it('asks the coding agent to run executable Node tests before completion', () => {
    const prompt = buildUserPrompt({
      prompt: 'Build Hacker News API tools.',
      pluginDir: '/plugins/hacker-news'
    });

    expect(prompt).toContain('node --test');
    expect(prompt).toContain('Do not report completion until');
  });

  it('switches to an interactive edit prompt when editMode is set', () => {
    const sys = buildSystemPrompt({ editMode: true, name: 'hacker-news', pluginDir: '/plugins/hacker-news' });
    // Edit mode: smallest change, adapt to existing conventions, no fresh stub,
    // and the current source is embedded so it should not re-read files.
    expect(sys).toContain('interactive coding agent editing an existing');
    expect(sys).toContain('DO NOT re-read');
    expect(sys).toContain('SMALLEST change');
    expect(sys).toMatch(/monster card.*dnd_get_monster/);
    expect(sys).not.toContain('empty registry');
    // The shared card contract still applies.
    expect(sys).toContain('Result-card rules');
    expect(sys).toContain('CardBlock');

    const user = buildUserPrompt({
      editMode: true,
      prompt: 'add a delta metric to the score',
      messages: [
        { role: 'user', content: 'add nice rendering to hn_get_item' },
        { role: 'assistant', content: 'added a card' }
      ]
    });
    expect(user).toContain('Recent conversation so far');
    expect(user).toContain('add a delta metric to the score');
    expect(user).toContain('smallest change');
  });

  it('keeps the create prompt as the default when editMode is falsy', () => {
    const sys = buildSystemPrompt({ sourceUrls: [] });
    expect(sys).toContain('empty registry');
    expect(sys).not.toContain('interactive coding agent editing an existing');
  });

  it('finds supported test files and rejects structure-only output', () => {
    expect(
      findPluginTestFiles(['index.ts', 'index.test.ts', 'fixtures.json', 'client.test.mjs'])
    ).toEqual(['client.test.mjs', 'index.test.ts']);

    expect(() =>
      validatePluginArtifacts({
        files: ['index.ts', 'README.md'],
        readme: '# Plugin',
        tools: []
      })
    ).toThrow('at least one executable test');
  });

  it('requires runtime tools and an endpoint inventory', () => {
    expect(() =>
      validatePluginArtifacts({
        files: ['index.ts', 'index.test.ts', 'README.md'],
        readme: '# Plugin',
        tools: [{ name: 'getStoryList' }]
      })
    ).toThrow('Endpoint Inventory');

    expect(() =>
      validatePluginArtifacts({
        files: ['index.ts', 'index.test.ts', 'README.md'],
        readme: '# Plugin\n\n## Endpoint Inventory\n\n- stories',
        tools: []
      })
    ).toThrow('at least one runtime tool');
  });

  it('rejects tools that are not callable and accepts callable ones', () => {
    const base = {
      files: ['index.ts', 'index.test.ts', 'README.md'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- stories'
    };

    expect(() =>
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'hn_list_stories', callable: false }]
      })
    ).toThrow(/execute/);

    expect(
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'hn_list_stories', callable: true }]
      })
    ).toEqual({ testFiles: ['index.test.ts'], toolCount: 1, cardCount: 0 });
  });

  it('accepts a valid result card and counts it', () => {
    const base = {
      files: ['index.ts', 'index.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    const card = {
      name: { singular: 'thing', plural: 'things' },
      title: '{{name}}',
      layout: [
        { component: 'Image', field: 'image', alt: '{{name}}' },
        { component: 'MetricRow', items: [{ label: 'Price', field: 'price', tone: 'delta' }] },
        { component: 'Section', title: 'More', layout: [{ component: 'Text', text: '{{note}}' }] }
      ]
    };
    expect(
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'get_thing', callable: true, card }]
      })
    ).toEqual({ testFiles: ['index.test.ts'], toolCount: 1, cardCount: 1 });
  });

  it('accepts nested Columns, Grid, and Stack card primitives', () => {
    const base = {
      files: ['index.ts', 'index.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    const card = {
      name: { singular: 'monster', plural: 'monsters' },
      title: '{{name}}',
      layout: [{
        component: 'Columns',
        columns: [
          {
            width: 3,
            layout: [{
              component: 'Stack',
              layout: [{ component: 'Text', text: '{{description}}' }]
            }]
          },
          {
            width: 1,
            layout: [{
              component: 'Grid',
              columns: 1,
              layout: [{ component: 'Image', field: 'image', variant: 'media' }]
            }]
          }
        ]
      }]
    };

    expect(
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'dnd_get_monster', callable: true, card }]
      })
    ).toEqual({ testFiles: ['index.test.ts'], toolCount: 1, cardCount: 1 });
  });

  it('rejects a result card without singular and plural display names', () => {
    const base = {
      files: ['index.ts', 'index.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    expect(() =>
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'get_thing', callable: true, card: { layout: [{ component: 'Text', text: 'Thing' }] } }]
      })
    ).toThrow(/singular.*plural/i);
  });

  it('rejects a card with an unknown component', () => {
    const base = {
      files: ['index.ts', 'index.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    expect(() =>
      validatePluginArtifacts({
        ...base,
        tools: [{
          name: 'get_thing',
          callable: true,
          card: {
            name: { singular: 'thing', plural: 'things' },
            layout: [{ component: 'Chart' }]
          }
        }]
      })
    ).toThrow(/unknown component/i);
  });

  it('rejects unknown components nested inside layout containers', () => {
    const base = {
      files: ['index.ts', 'index.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    expect(() =>
      validatePluginArtifacts({
        ...base,
        tools: [{
          name: 'get_thing',
          callable: true,
          card: {
            name: { singular: 'thing', plural: 'things' },
            layout: [{
              component: 'Columns',
              columns: [
                { width: 3, layout: [{ component: 'Text', text: 'Thing' }] },
                { width: 1, layout: [{ component: 'Chart' }] }
              ]
            }]
          }
        }]
      })
    ).toThrow(/unknown component.*Chart/i);
  });

  it('rejects a card with no layout blocks', () => {
    const base = {
      files: ['index.ts', 'index.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    expect(() =>
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'get_thing', callable: true, card: { layout: [] } }]
      })
    ).toThrow(/layout/i);
  });
});
