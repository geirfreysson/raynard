import { describe, expect, it } from 'vitest';
import {
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
