import { describe, expect, it } from 'vitest';
import {
  assertBuilderTurnCompleted,
  bashCommandEscapesRoot,
  resolveInsideRoot,
  buildTargetedPluginSnapshot,
  buildSystemPrompt,
  buildUserPrompt,
  assessLiveToolResult,
  findPluginTestFiles,
  findUnpinnedTestHosts,
  findUsedCredentialKeys,
  selectLiveSmokeTool,
  hasAuthoredPluginWork,
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

  it('surfaces the provider failure that ended the turn', () => {
    // Without this the caller only learns the turn stopped, and the generic
    // validation failure that follows ("no runtime tool") gets the blame.
    expect(() =>
      assertBuilderTurnCompleted({
        editMode: false,
        madeFileEdits: true,
        stopReason: 'error',
        errorMessage: '402 insufficient balance'
      })
    ).toThrow(/402 insufficient balance/);
    expect(() =>
      assertBuilderTurnCompleted({
        editMode: false,
        madeFileEdits: true,
        stopReason: 'length',
        errorMessage: ''
      })
    ).toThrow(/output limit/i);
  });

  it('writes one tool at a time instead of drafting whole files in reasoning', () => {
    const prompt = buildUserPrompt({ prompt: 'Build it', pluginDir: '/tmp/p' });

    expect(prompt).toMatch(/one tool completely before starting the next/i);
    expect(prompt).toMatch(/never draft file contents in your reasoning/i);
  });

  it('tells an untouched scaffold apart from a workspace with authored work', () => {
    const stub = 'export const tools = defineTools({});';
    expect(
      hasAuthoredPluginWork({ files: ['plugin.json', 'tools.ts', 'README.md'], toolsSource: stub })
    ).toBe(false);
    // What the failed weather build actually left behind.
    expect(
      hasAuthoredPluginWork({
        files: ['plugin.json', 'tools.ts', 'README.md', 'client.ts', 'client.test.ts'],
        toolsSource: stub
      })
    ).toBe(true);
    // Only tools.ts written, no supporting files yet.
    expect(
      hasAuthoredPluginWork({
        files: ['plugin.json', 'tools.ts', 'README.md'],
        toolsSource: 'export const tools = defineTools({ a: {} });'
      })
    ).toBe(true);
    expect(hasAuthoredPluginWork({ files: [], toolsSource: '' })).toBe(false);
  });

  it('resumes an unfinished build from what is already on disk', () => {
    // A failed fresh build leaves real work behind (a passing client.ts and its
    // tests). Restarting blind made the agent rediscover or redo all of it.
    const prompt = buildUserPrompt({
      prompt: 'Build the weather plugin',
      pluginDir: '/data/generated-plugins/openweathermap',
      pluginSnapshot: 'Files in this plugin: client.ts, client.test.ts, tools.ts',
      messages: [
        { role: 'user', content: 'i want to talk to the weather api' },
        { role: 'assistant', content: 'Switched to Build mode' }
      ]
    });

    expect(prompt).toMatch(/resuming an unfinished build/i);
    expect(prompt).toContain('Files in this plugin: client.ts, client.test.ts, tools.ts');
    expect(prompt).toContain('i want to talk to the weather api');
    expect(prompt).toMatch(/do not start over|keep what already works/i);
  });

  it('leaves a genuinely fresh build prompt alone', () => {
    const prompt = buildUserPrompt({ prompt: 'Build it', pluginDir: '/tmp/p' });

    expect(prompt).not.toMatch(/resuming an unfinished build/i);
    expect(prompt).toContain('Implement this Raynard Explore-mode API plugin');
  });

  it('hands the builder the SDK surface instead of making it go looking', () => {
    // The first build spent 11 tool calls locating the SDK, reading its .d.ts,
    // then reading its .js implementation, then cribbing from a sibling plugin.
    const prompt = buildSystemPrompt({
      sourceUrls: [],
      sdkDir: '/data/generated-plugins/node_modules/@raynard/plugin-sdk',
      sdkTypes: {
        'index.d.ts': 'export function requireCredential(key: string, label?: string): string;',
        'testing.d.ts': 'export function mockFetch(handler: unknown): unknown;'
      }
    });

    expect(prompt).toContain('/data/generated-plugins/node_modules/@raynard/plugin-sdk');
    expect(prompt).toContain('export function requireCredential(key: string, label?: string)');
    expect(prompt).toContain('export function mockFetch');
    expect(prompt).toMatch(/do not search for it/i);
    expect(prompt).toMatch(/never read the SDK's `\.js`|never read the SDK's \.js/i);
    expect(prompt).toMatch(/do not copy from (?:a )?sibling plugin/i);
  });

  it('names every credential helper it tells the builder to use', () => {
    const prompt = buildSystemPrompt({ sourceUrls: [] });

    // requireCredential was instructed but absent from the import list, and its
    // real signature takes a label; configureCredentials was never mentioned at
    // all, so mocked tests for an authenticated tool had nowhere to start.
    expect(prompt).toContain('requireCredential');
    expect(prompt).toContain('configureCredentials');
    expect(prompt).toMatch(/requireCredential\('[A-Z_]+', '[^']+'\)/);
  });

  it('states an already-known credential instead of asking the builder to research it', () => {
    const prompt = buildSystemPrompt({
      sourceUrls: [],
      auth: {
        required: true,
        credentialLabel: 'OpenWeatherMap API key',
        signupUrl: 'https://home.openweathermap.org/users/sign_up'
      }
    });

    expect(prompt).toContain('OpenWeatherMap API key');
    expect(prompt).toContain('https://home.openweathermap.org/users/sign_up');
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
    expect(prompt).toMatch(/belongs in those descriptions, not only in README\.md/i);
    // The specific facts that have to be written down.
    expect(prompt).toMatch(/only take effect in combination or are ignored on their own/i);
    expect(prompt).toMatch(/inputs the API silently drops/i);
    expect(prompt).toMatch(/sort order of results/i);
    expect(prompt).toMatch(/result caps, maximum page size, and how to page/i);
    // A mocked URL assertion is not proof the API honored the parameter.
    expect(prompt).toMatch(/Mocked tests prove only what the plugin SENT/i);
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

  it('briefly requires domain-neutral catalog metadata in fresh build prompts', () => {
    const system = buildSystemPrompt({ sourceUrls: [] });
    const user = buildUserPrompt({ prompt: 'Build it', pluginDir: '/tmp/p' });

    expect(system).toContain('plugin.json.catalogMetadata');
    expect(system).toMatch(/best-fit category from:/i);
    expect(system).toMatch(/4–7.*lowercase kebab-case tags.*include api/i);
    expect(system).toMatch(/icon.*book-open.*database.*message-square/i);
    expect(system).not.toMatch(/eurostat/i);
    expect(user).toContain('catalogMetadata');
  });

  it('validates builder-authored catalog metadata for fresh plugins', () => {
    const valid = {
      files: ['tools.ts', 'tools.test.ts'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- routes',
      tools: [{ name: 'transit_list_routes', callable: true, card: requiredCard }],
      requireCatalogMetadata: true
    };
    const catalogMetadata = {
      category: 'Maps',
      tags: ['transit', 'routes', 'cities', 'api'],
      icon: 'database'
    };

    expect(() => validatePluginArtifacts({ ...valid })).toThrow(/catalogMetadata/i);
    expect(() =>
      validatePluginArtifacts({
        ...valid,
        catalogMetadata: { ...catalogMetadata, category: 'Miscellaneous' }
      })
    ).toThrow(/category/i);
    expect(() =>
      validatePluginArtifacts({
        ...valid,
        catalogMetadata: { ...catalogMetadata, tags: ['transit', 'API'] }
      })
    ).toThrow(/4–7.*kebab-case.*api/i);
    expect(() =>
      validatePluginArtifacts({
        ...valid,
        catalogMetadata: { ...catalogMetadata, icon: 'map' }
      })
    ).toThrow(/icon/i);
    expect(validatePluginArtifacts({ ...valid, catalogMetadata })).toMatchObject({
      catalogMetadata
    });
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

  it('picks the first zero-argument tool for the live smoke call', () => {
    const tools = [
      { name: 'hn_get_story', callable: true, parameters: { type: 'object', required: ['id'] } },
      { name: 'hn_list_top', callable: true, parameters: { type: 'object', required: [] } },
      { name: 'hn_list_new', callable: true, parameters: { type: 'object' } }
    ];
    expect(selectLiveSmokeTool(tools)?.name).toBe('hn_list_top');

    // Nothing callable without arguments: the gate cannot invent valid ids.
    expect(selectLiveSmokeTool([tools[0]])).toBeNull();
    expect(selectLiveSmokeTool([{ name: 'x', callable: false, parameters: { type: 'object' } }])).toBeNull();
  });

  it('accepts a live result only when it carries real content', () => {
    const good = {
      ok: true,
      result: { text: '3 stories', references: [{ referenceId: '1' }], data: { stories: [{ id: 1 }] } }
    };
    expect(assessLiveToolResult(good)).toMatchObject({ ok: true });

    // A 200 with nothing in it is the exact failure mocked tests cannot see.
    expect(assessLiveToolResult({ ok: false, error: 'HTTP 404 for https://api.example.com/x' })).toMatchObject({
      ok: false
    });
    expect(assessLiveToolResult({ ...good, result: { ...good.result, text: '  ' } }).message).toMatch(/text/i);
    expect(assessLiveToolResult({ ...good, result: { ...good.result, references: [] } }).message).toMatch(
      /reference/i
    );
    expect(
      assessLiveToolResult({ ...good, result: { ...good.result, data: { stories: [] } } }).message
    ).toMatch(/empty/i);

    // A credential the host has not stored is a user-input need, not a defect.
    expect(
      assessLiveToolResult({ ok: false, error: 'missing', credentialRequest: { key: 'K', label: 'K' } })
    ).toMatchObject({ ok: true, skipped: expect.stringMatching(/credential/i) });
  });

  it('requires at least one test to pin a literal API origin', () => {
    const sources = ["const BASE = 'https://api.example.com/v1';"];

    // Matching on a constant imported from the module under test follows any
    // base-URL rewrite, so the suite stays green while every live call 404s.
    expect(findUnpinnedTestHosts(sources, ["if (url === `${BASE}/items`) return { body: {} };"])).toEqual([
      'https://api.example.com'
    ]);
    expect(findUnpinnedTestHosts(sources, ["assert.ok(url.includes('/items'));"])).toEqual([
      'https://api.example.com'
    ]);
    expect(
      findUnpinnedTestHosts(sources, ["assert.ok(calls[0].startsWith('https://api.example.com/v1/items'));"])
    ).toEqual([]);
    // Nothing to pin when the sources name no absolute URL.
    expect(findUnpinnedTestHosts(["const x = 1;"], ['const y = 2;'])).toEqual([]);
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

  it('tells both builder prompts to observe the API before trusting a green suite', () => {
    // The IMF plugin was rewritten across four base URLs on the strength of a
    // fully mocked, fully passing suite. Both prompts must send the model to
    // the API itself, and the create prompt's example must model the URL
    // assertion rather than the ignore-the-URL mock it used to show.
    const create = buildSystemPrompt({ sourceUrls: [] });
    expect(create).toMatch(/call every endpoint with bash \(curl\) BEFORE writing client code/i);
    expect(create).toMatch(/a 2xx is not success/i);
    expect(create).toMatch(/204 and an empty body/i);
    expect(create).toMatch(/assert\.equal\(fetchMock\.calls\[0\], 'https:\/\/api\.example\.com\/things\/1'\)/);
    expect(create).toMatch(/calling one zero-argument tool against the real API/i);

    const edit = buildSystemPrompt({ editMode: true, pluginDir: '/p', name: 'P' });
    expect(edit).toMatch(/mocked tests cannot tell you whether the plugin works/i);
    expect(edit).toMatch(/curl it first/i);
    expect(edit).toMatch(/never by guessing another base URL/i);
  });

  it('fails validation when no test pins the API host', () => {
    const base = {
      files: ['tools.ts', 'tools.test.ts', 'README.md'],
      readme: '# Plugin\n\n## Endpoint Inventory\n\n- things',
      tools: [{ name: 'get_thing', callable: true, card: requiredCard }],
      sources: ["const BASE = 'https://api.example.com';"]
    };
    expect(() =>
      validatePluginArtifacts({ ...base, testSources: ["assert.ok(url.includes('/things'));"] })
    ).toThrow(/pins the API host/i);
    expect(() =>
      validatePluginArtifacts({
        ...base,
        testSources: ["assert.equal(calls[0], 'https://api.example.com/things/1');"]
      })
    ).not.toThrow();
    // Callers that do not supply test sources keep the old behavior.
    expect(() => validatePluginArtifacts(base)).not.toThrow();
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

  describe('workspace containment', () => {
    const root = '/data/generated-plugins/open-weather';

    it('accepts paths inside the plugin workspace', () => {
      expect(resolveInsideRoot(root, 'tools.ts')).toBe(`${root}/tools.ts`);
      expect(resolveInsideRoot(root, './nested/client.ts')).toBe(`${root}/nested/client.ts`);
      expect(resolveInsideRoot(root, `${root}/README.md`)).toBe(`${root}/README.md`);
      expect(resolveInsideRoot(root, '.')).toBe(root);
    });

    it('rejects the sibling-plugin and filesystem escapes pi would otherwise allow', () => {
      // The exact move that prompted this: reading another plugin to copy from.
      expect(resolveInsideRoot(root, '../hacker-news/tools.ts')).toBeNull();
      expect(resolveInsideRoot(root, '../node_modules/@raynard/plugin-sdk/index.js')).toBeNull();
      expect(resolveInsideRoot(root, '/etc/passwd')).toBeNull();
      expect(resolveInsideRoot(root, '~/.ssh/id_rsa')).toBeNull();
      expect(resolveInsideRoot(root, '')).toBeNull();
      // A sibling directory sharing a name prefix is still outside.
      expect(resolveInsideRoot(root, '../open-weather-2/tools.ts')).toBeNull();
    });

    it('blocks bash commands that leave the workspace', () => {
      expect(bashCommandEscapesRoot('cat ../hacker-news/tools.ts')).toBe(true);
      expect(bashCommandEscapesRoot('ls ..')).toBe(true);
      expect(bashCommandEscapesRoot('cat ~/.aws/credentials')).toBe(true);
      expect(bashCommandEscapesRoot('grep -r defineTools /Users/someone/plugins')).toBe(true);
      expect(bashCommandEscapesRoot('cat ../node_modules/@raynard/plugin-sdk/index.d.ts')).toBe(
        true
      );
    });

    it('leaves ordinary in-workspace commands alone', () => {
      expect(bashCommandEscapesRoot('node --test tools.test.ts')).toBe(false);
      expect(bashCommandEscapesRoot('ls -la')).toBe(false);
      expect(bashCommandEscapesRoot('grep -n defineTools tools.ts')).toBe(false);
      expect(bashCommandEscapesRoot('node --test ./client.test.ts')).toBe(false);
      // Not a path segment: an ellipsis in a string and a version range.
      expect(bashCommandEscapesRoot('echo "loading..."')).toBe(false);
    });
  });
});
