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
    ).toEqual({ testFiles: ['index.test.ts'], toolCount: 1 });
  });
});
