import { describe, expect, it } from 'vitest';
import {
  assertBuilderTurnCompleted,
  buildTargetedPluginSnapshot,
  buildSystemPrompt,
  buildUserPrompt,
  findPluginTestFiles,
  findUsedCredentialKeys,
  normalizePluginAuth,
  validatePluginArtifacts
} from './plugin-builder-core.mjs';

const requiredCard = {
  name: { singular: 'result', plural: 'results' },
  layout: [{ component: 'Json' }]
};

describe('plugin builder core', () => {
  it('rejects truncated and no-change builder turns', () => {
    expect(() =>
      assertBuilderTurnCompleted({ editMode: true, madeFileEdits: false, stopReason: 'stop' })
    ).toThrow(/without writing any changes/i);
    expect(() =>
      assertBuilderTurnCompleted({ editMode: true, madeFileEdits: true, stopReason: 'length' })
    ).toThrow(/output limit/i);
    expect(() =>
      assertBuilderTurnCompleted({ editMode: false, madeFileEdits: true, stopReason: 'aborted' })
    ).toThrow(/interrupted/i);
    expect(() =>
      assertBuilderTurnCompleted({ editMode: true, madeFileEdits: true, stopReason: 'stop' })
    ).not.toThrow();
  });

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
    expect(prompt).toMatch(/every row returned.*fetched API page/i);
    expect(prompt).toMatch(/model-visible text.*bounded/i);
    expect(prompt).toContain('samplePrompts');
    expect(prompt).toMatch(/exactly three/i);
  });

  it('makes tool descriptions the home for API operating knowledge', () => {
    const prompt = buildSystemPrompt({ sourceUrls: [] });

    // The agent only ever sees the description and the parameter schema, so the
    // prompt must say so rather than pointing API semantics at README.
    expect(prompt).toMatch(/ONLY plugin text the Explore agent ever sees/i);
    expect(prompt).toMatch(/README\.md, code comments, and plugin\.json never reach it/i);
    expect(prompt).toMatch(/must never be its only home/i);
    // The specific facts that have to be written down.
    expect(prompt).toMatch(/only take effect in combination or are ignored on their own/i);
    expect(prompt).toMatch(/inputs the API silently drops/i);
    expect(prompt).toMatch(/sort order of results/i);
    expect(prompt).toMatch(/result caps, maximum page size, and how to page/i);
    // A mocked URL assertion is not proof the API honored the parameter.
    expect(prompt).toMatch(/proves only what the plugin SENT, never that the API honored it/i);
  });

  it('keeps tool descriptions truthful when an edit changes behavior', () => {
    const prompt = buildSystemPrompt({ editMode: true, name: 'world-bank-data360' });

    expect(prompt).toMatch(/update that tool's description and parameter descriptions in the SAME turn/i);
    expect(prompt).toMatch(/stale description silently teaches the agent to call the tool wrongly/i);
  });

  it('requires three usable splash prompts for fresh plugin builds', () => {
    const valid = {
      files: ['tools.ts', 'tools.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- stories',
      tools: [{ name: 'hn_list_stories', callable: true, card: requiredCard }],
      requireSamplePrompts: true
    };

    expect(() =>
      validatePluginArtifacts({ ...valid, samplePrompts: ['Only one prompt'] })
    ).toThrow(/exactly three/i);
    expect(
      validatePluginArtifacts({
        ...valid,
        samplePrompts: [
          'Who wrote the top Hacker News story today?',
          'Show me the three most discussed stories.',
          'What is the newest story on Hacker News?'
        ]
      })
    ).toEqual({ testFiles: ['tools.test.ts'], toolCount: 1, cardCount: 1, credentials: [] });
  });

  it('embeds a canonical tool template that pins the execute method and tool shape', () => {
    const prompt = buildSystemPrompt({ sourceUrls: [] });

    expect(prompt).toContain('Canonical shape');
    expect(prompt).toContain('async execute(args');
    expect(prompt).toContain('export const tools = defineTools({');
    expect(prompt).toContain('tools[name].execute(args)');
    expect(prompt).toContain('MUST be named exactly "execute"');
    expect(prompt).toContain('Never use "handler"');
  });

  it('directs the builder to reuse the shared SDK instead of vendored plumbing', () => {
    const prompt = buildSystemPrompt({ sourceUrls: [] });

    expect(prompt).toContain('@raynard/plugin-sdk');
    expect(prompt).toContain('apiGet');
    expect(prompt).toContain('mockFetch');
    expect(prompt).toContain('@raynard/plugin-sdk/testing');
    expect(prompt).toMatch(/do not create.*runtime\.ts/i);
    expect(prompt).toMatch(/MUST reuse.*MUST NOT re-implement/);
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
    expect(prompt).toContain('HOST_SDK_OUTDATED:');
  });

  it('builds a targeted card snapshot beyond the general source cap', () => {
    const filler = `const filler = '${'x'.repeat(17000)}';\n`;
    const toolsSource = `${filler}
export const tools = defineTools({
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
});`;
    const testSource = `
test('unrelated tool works', () => tools.unrelated_tool.execute({}));
test('dnd_get_monster card layout', () => {
  assert.equal(tools.dnd_get_monster.card.layout[0].component, 'Image');
});`;
    const sdkSource = `
export type CardBlock =
  | { component: 'Columns'; columns: { width?: number; layout: CardBlock[] }[] }
  | { component: 'Image'; field: string; variant?: 'avatar' | 'media' };
export type CardTemplate = { title?: string; layout: CardBlock[] };
export type UnrelatedRuntimeType = { ignored: true };`;

    const snapshot = buildTargetedPluginSnapshot({
      files: {
        'tools.ts': toolsSource,
        'tools.test.ts': testSource,
        'sdk.d.ts': sdkSource,
        'README.md': 'Unrelated documentation'
      },
      taskKind: 'card-edit',
      targetTools: ['dnd_get_monster']
    });

    expect(snapshot).toContain('TARGETED CARD-EDIT SNAPSHOT');
    expect(snapshot).toContain('dnd_get_monster');
    expect(snapshot).toContain("title: '{{name}}'");
    expect(snapshot).toContain("test('dnd_get_monster card layout'");
    expect(snapshot).toContain('===== sdk.d.ts :: canonical card types =====');
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
    expect(prompt).toMatch(/brief plan/i);
    expect(prompt).toMatch(/first failing test/i);
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
    expect(sys).toContain('author-owned workspace is intentionally small');
    expect(sys).toContain('defineTools');
    expect(sys).not.toContain('interactive coding agent editing an existing');
  });

  it('finds supported test files and rejects structure-only output', () => {
    expect(
      findPluginTestFiles(['tools.ts', 'tools.test.ts', 'fixtures.json', 'client.test.mjs'])
    ).toEqual(['client.test.mjs', 'tools.test.ts']);

    expect(() =>
      validatePluginArtifacts({
        files: ['tools.ts', 'README.md'],
        readme: '# Plugin',
        tools: []
      })
    ).toThrow('at least one executable test');
  });

  it('requires runtime tools and an endpoint inventory', () => {
    expect(() =>
      validatePluginArtifacts({
        files: ['tools.ts', 'tools.test.ts', 'README.md'],
        readme: '# Plugin',
        tools: [{ name: 'getStoryList' }]
      })
    ).toThrow('Endpoint Inventory');

    expect(() =>
      validatePluginArtifacts({
        files: ['tools.ts', 'tools.test.ts', 'README.md'],
        readme: '# Plugin\n\n## Endpoint Inventory\n\n- stories',
        tools: []
      })
    ).toThrow('at least one runtime tool');
  });

  it('rejects tools that are not callable and accepts callable ones', () => {
    const base = {
      files: ['tools.ts', 'tools.test.ts', 'README.md'],
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
        tools: [{ name: 'hn_list_stories', callable: true, card: requiredCard }]
      })
    ).toEqual({ testFiles: ['tools.test.ts'], toolCount: 1, cardCount: 1, credentials: [] });
  });

  it('requires every runtime tool, including list and search tools, to declare a card', () => {
    expect(() =>
      validatePluginArtifacts({
        files: ['tools.ts', 'tools.test.ts'],
        readme: '# Plugin\n\n## Endpoint Inventory\n\n- /stories Implemented',
        tools: [{ name: 'hn_list_stories', callable: true }]
      })
    ).toThrow(/every tool.*card/i);
  });

  it('accepts a valid result card and counts it', () => {
    const base = {
      files: ['tools.ts', 'tools.test.ts'],
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
    ).toEqual({ testFiles: ['tools.test.ts'], toolCount: 1, cardCount: 1, credentials: [] });
  });

  it('accepts nested Columns, Grid, and Stack card primitives', () => {
    const base = {
      files: ['tools.ts', 'tools.test.ts'],
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
    ).toEqual({ testFiles: ['tools.test.ts'], toolCount: 1, cardCount: 1, credentials: [] });
  });

  it('rejects a result card without singular and plural display names', () => {
    const base = {
      files: ['tools.ts', 'tools.test.ts'],
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
      files: ['tools.ts', 'tools.test.ts'],
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
      files: ['tools.ts', 'tools.test.ts'],
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
      files: ['tools.ts', 'tools.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- /things Implemented'
    };
    expect(() =>
      validatePluginArtifacts({
        ...base,
        tools: [{ name: 'get_thing', callable: true, card: { layout: [] } }]
      })
    ).toThrow(/layout/i);
  });

  describe('plugin credentials', () => {
    const validCredential = {
      key: 'OPENWEATHER_API_KEY',
      label: 'OpenWeather API key',
      description: 'Free tier.',
      signupUrl: 'https://openweathermap.org/api'
    };

    const base = {
      files: ['tools.ts', 'tools.test.ts', 'README.md'],
      tools: [{ name: 'weather_current', callable: true, card: requiredCard }]
    };

    const readmeWithAuth = [
      '# Plugin',
      '',
      '## Endpoint Inventory',
      '',
      '- current weather',
      '',
      '## Authentication',
      '',
      '- OPENWEATHER_API_KEY — get one at https://openweathermap.org/api'
    ].join('\n');

    const readmeWithoutAuth = '# Plugin\n\n## Endpoint Inventory\n\n- current weather';

    it('normalizes declarations and drops unusable ones', () => {
      expect(normalizePluginAuth({ auth: { credentials: [validCredential] } })).toEqual([
        validCredential
      ]);
      expect(normalizePluginAuth(undefined)).toEqual([]);
      // A lowercase key cannot be a keychain account component.
      expect(
        normalizePluginAuth({ auth: { credentials: [{ ...validCredential, key: 'lower_case' }] } })
      ).toEqual([]);
      // A declaration with no sign-up page cannot tell the user where to go.
      expect(
        normalizePluginAuth({ auth: { credentials: [{ ...validCredential, signupUrl: '' }] } })
      ).toEqual([]);
      expect(
        normalizePluginAuth({
          auth: { credentials: [{ ...validCredential, signupUrl: 'ftp://example.com' }] }
        })
      ).toEqual([]);
      expect(
        normalizePluginAuth({ auth: { credentials: [{ ...validCredential, label: '' }] } })
      ).toEqual([]);
      expect(
        normalizePluginAuth({ auth: { credentials: [validCredential, validCredential] } })
      ).toHaveLength(1);
    });

    it('finds the credential keys a plugin actually reads', () => {
      expect(
        findUsedCredentialKeys([
          "const key = requireCredential('OPENWEATHER_API_KEY');",
          'const other = requireCredential("SECOND_KEY", "Second");'
        ])
      ).toEqual(['OPENWEATHER_API_KEY', 'SECOND_KEY']);
      expect(findUsedCredentialKeys('no credentials here')).toEqual([]);
    });

    it('rejects a credential the plugin reads but never declares', () => {
      expect(() =>
        validatePluginArtifacts({
          ...base,
          readme: readmeWithAuth,
          sources: ["requireCredential('UNDECLARED_KEY')"]
        })
      ).toThrow(/Undeclared: UNDECLARED_KEY/);
    });

    it('requires the README to document where the key comes from', () => {
      expect(() =>
        validatePluginArtifacts({
          ...base,
          readme: readmeWithoutAuth,
          auth: { credentials: [validCredential] },
          sources: ["requireCredential('OPENWEATHER_API_KEY')"]
        })
      ).toThrow(/Authentication/);

      expect(() =>
        validatePluginArtifacts({
          ...base,
          readme: '# Plugin\n\n## Endpoint Inventory\n\n- x\n\n## Authentication\n\nAsk someone.',
          auth: { credentials: [validCredential] },
          sources: ["requireCredential('OPENWEATHER_API_KEY')"]
        })
      ).toThrow(/sign-up URL for: OPENWEATHER_API_KEY/);
    });

    it('accepts a plugin whose declaration, usage, and README agree', () => {
      const result = validatePluginArtifacts({
        ...base,
        readme: readmeWithAuth,
        auth: { credentials: [validCredential] },
        sources: ["requireCredential('OPENWEATHER_API_KEY')"]
      });

      expect(result.credentials).toEqual([validCredential]);
      expect(result.toolCount).toBe(1);
    });

    it('passes with credentials declared and none configured, so the builder never needs a key', () => {
      // The builder runs with no keychain access at all; validation must not
      // depend on a value being present.
      expect(() =>
        validatePluginArtifacts({
          ...base,
          readme: readmeWithAuth,
          auth: { credentials: [validCredential] },
          sources: ["requireCredential('OPENWEATHER_API_KEY')"]
        })
      ).not.toThrow();
    });

    it('leaves plugins without credentials unaffected', () => {
      expect(() =>
        validatePluginArtifacts({
          ...base,
          readme: readmeWithoutAuth,
          sources: ['const x = 1;']
        })
      ).not.toThrow();
    });
  });
});
