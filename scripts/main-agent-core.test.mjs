import { describe, expect, it } from 'vitest';
import {
  buildPiTypeFromSchema,
  buildMainAgentSystemPrompt,
  createBuildRequestTool,
  createDirectAnswerTool,
  createGeneratedPluginTools,
  createModel,
  formatToolResult,
  MODEL_RESULT_BYTE_LIMIT,
  toAgentMessages
} from './main-agent-core.mjs';
import { Type } from '@mariozechner/pi-ai';

describe('main agent core', () => {
  it('creates Pi-compatible history and leaves the current user prompt out', () => {
    const messages = toAgentMessages(
      [
        { role: 'user', content: 'Earlier question' },
        { role: 'assistant', content: 'Earlier answer' },
        { role: 'user', content: 'Current question' }
      ],
      { provider: 'moonshot', model: 'kimi-k2.5' }
    );

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(messages[0].content).toBe('Earlier question');
    expect(messages[1].content[0].text).toBe('Earlier answer');
  });

  it('builds a provider-compatible Pi model descriptor', () => {
    expect(
      createModel({
        provider: 'moonshot',
        model: 'kimi-k2.5',
        baseUrl: 'https://api.moonshot.ai/v1'
      })
    ).toMatchObject({
      id: 'kimi-k2.5',
      api: 'openai-completions',
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.ai/v1'
    });
  });

  it('sets strict Explore and Build boundaries in the system prompt', () => {
    const explore = buildMainAgentSystemPrompt({ mode: 'explore', toolNames: ['getStoryList'] });
    const build = buildMainAgentSystemPrompt({ mode: 'build', toolNames: [] });

    expect(explore).toContain('Never write code or invoke the coding agent');
    expect(explore).toContain('request_plugin_build');
    expect(explore).toContain('Do not answer the inaccessible factual question');
    expect(explore).toContain('official API documentation URL');
    expect(build).toContain('Do not answer a build request with code');
    expect(build).toContain('request_plugin_build');
    expect(build).toContain('Only the separate Pi coding agent may write plugin files');
  });

  it('teaches the agent that result cards are a built-in feature, not content to design', () => {
    const build = buildMainAgentSystemPrompt({ mode: 'build', toolNames: ['dnd_get_spell'] });

    // Cards are recognized as a rendering feature the app owns.
    expect(build).toContain('Result cards');
    expect(build).toMatch(/every.*tool.*card/i);
    // It must not interrogate the user about visual format / card types.
    expect(build).toMatch(/do NOT ask what the cards should look like/i);
    expect(build).not.toContain('which of those tools should get a card');
    // Adding cards is itself a valid reason to call request_plugin_build.
    expect(build).toContain('adding result cards to specific tools');
  });

  it('teaches the chart fence and keeps charting an answer out of the build flow', () => {
    const explore = buildMainAgentSystemPrompt({ mode: 'explore', toolNames: ['data360_get_data'] });

    // The syntax and its required keys are documented.
    expect(explore).toContain('```chart');
    expect(explore).toMatch(/"type"\s*,?.*"x".*"series".*"rows"/s);
    expect(explore).toContain('"stacked" (bar only)');
    // The highlight option and when to reach for it.
    expect(explore).toContain('"highlight"');
    expect(explore).toMatch(/everything else is drawn muted/i);
    expect(explore).toMatch(/series label, a series key, or an x-axis value/i);
    // Only the two types the renderer implements.
    expect(explore).toMatch(/only two types/i);
    expect(explore).not.toMatch(/"type"\s*:\s*"(pie|scatter|area)"/);
    // A chart replaces the table rather than duplicating it.
    expect(explore).toMatch(/do NOT also write the same numbers as a Markdown table/i);
    expect(explore).toMatch(/never invent, extrapolate, or round data points/i);
    // Chart accuracy: verify the rows match the question before plotting.
    expect(explore).toMatch(/A tool can return data that ignores a filter you passed/i);
    expect(explore).toMatch(/do NOT chart them; call the tool again/i);
    expect(explore).toMatch(/Never chart a partial slice as if it were complete/i);
    expect(explore).toMatch(/omit the chart rather than plotting something unverified/i);
    // Charting an answer must not be mistaken for a plugin/card change.
    expect(explore).toMatch(/is not a plugin change/i);
    expect(explore).toMatch(/Only a request to change how a PLUGIN or its result card renders is a build request/);
  });

  it('requires a tool call in the current turn before making API claims or claiming cards appeared', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['fpl_search_players']
    });

    expect(explore).toMatch(/current turn/i);
    expect(explore).toMatch(/never narrate.*tool call/i);
    expect(explore).toMatch(/never claim.*card.*shown/i);
    expect(explore).toMatch(/first response MUST be a tool call/i);
    expect(explore).toContain('answer_without_api');
  });

  it('provides a terminating direct-answer action only for non-API conversation', async () => {
    const answers = [];
    const tool = createDirectAnswerTool(Type, (answer) => answers.push(answer));
    const result = await tool.execute('direct-1', {
      answer: 'Hello! How can I help?',
      reason: 'Greeting without external factual claims.'
    });

    expect(tool.name).toBe('answer_without_api');
    expect(tool.description).toMatch(/never.*external|not.*external/i);
    expect(answers).toEqual(['Hello! How can I help?']);
    expect(result.terminate).toBe(true);
    expect(result.details.type).toBe('direct-answer');
  });

  it('routes visual changes to existing cards through the plugin builder', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['dnd_get_monster'],
      plugins: [{ slug: 'dnd-5e-api', name: 'Dnd 5e Api' }]
    });

    expect(explore).toMatch(/reposition|resize|layout|appearance/i);
    expect(explore).toMatch(/MUST call request_plugin_build/i);
    expect(explore).toMatch(/must not claim|never claim/i);
  });

  it('puts the AI routing decision before all answer policy', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['dnd_get_monster'],
      plugins: [{ slug: 'dnd-5e-api', name: 'Dnd 5e Api' }]
    });

    expect(explore.indexOf('FIRST-ACTION ROUTING')).toBeLessThan(explore.indexOf('Result cards'));
    expect(explore).toMatch(/create, edit, fix, or otherwise change.*plugin/i);
    expect(explore).toMatch(/card layout.*image placement.*size/i);
    expect(explore).toMatch(/questions about data.*installed API tools/i);
    expect(explore).toMatch(/call request_plugin_build immediately/i);
    expect(explore).toMatch(/Do not inspect files.*narrate edits.*run tests/i);
  });

  it('lists installed plugins and forbids inventing names for existing ones', () => {
    const build = buildMainAgentSystemPrompt({
      mode: 'build',
      toolNames: ['dnd_get_monster'],
      plugins: [
        { slug: 'dnd-5e-api', name: 'Dnd 5e Api' },
        { slug: 'hacker-news', name: 'hacker-news' }
      ]
    });

    // The real plugin identities are surfaced so the agent edits the right one.
    expect(build).toContain('Installed plugins:');
    expect(build).toContain('dnd-5e-api');
    // Editing must reuse the exact name; a mismatch creates a duplicate.
    expect(build).toMatch(/EXACT name/);
    expect(build).toMatch(/creates a brand-new EMPTY plugin/i);
  });

  it('advertises result-card requests in the build tool description', () => {
    const tool = createBuildRequestTool(Type, () => {});
    expect(tool.description).toMatch(/result cards/i);
    expect(tool.description).toMatch(/rendering|presents its results|visualization/i);
    expect(tool.parameters.properties.taskKind.anyOf.map((entry) => entry.const)).toEqual([
      'card-edit',
      'plugin-edit',
      'plugin-create'
    ]);
    expect(tool.parameters.properties.targetTools.items.type).toBe('string');
  });

  it('converts JSON schema required fields and enums to Pi parameter schemas', () => {
    const schema = buildPiTypeFromSchema(Type, {
      type: 'object',
      required: ['type'],
      properties: {
        type: {
          type: 'string',
          enum: ['top', 'new'],
          description: 'Story list type.'
        },
        limit: {
          type: 'integer',
          description: 'Maximum stories.'
        }
      }
    });

    expect(schema.required).toEqual(['type']);
    expect(schema.properties.type.anyOf.map((entry) => entry.const)).toEqual(['top', 'new']);
    expect(schema.properties.limit.type).toBe('integer');
  });

  it('creates native Pi tools that execute against the owning plugin and preserve references', async () => {
    const executions = [];
    const tools = createGeneratedPluginTools({
      Type,
      plugins: [
        {
          id: 'hacker-news',
          directory: '/plugins/hacker-news',
          tools: [
            {
              name: 'getStoryList',
              description: 'Fetch Hacker News story lists.',
              parameters: {
                type: 'object',
                required: ['type'],
                properties: {
                  type: { type: 'string' }
                }
              },
              card: {
                name: { singular: 'story list', plural: 'story lists' },
                layout: [{ component: 'Table', columns: [{ header: 'Story', field: 'title' }], rows: 'stories' }]
              }
            }
          ]
        }
      ],
      executePluginTool: async (request) => {
        executions.push(request);
        return {
          text: 'Story one',
          references: [{ url: 'https://news.ycombinator.com/item?id=1' }],
          data: { stories: [{ title: 'Story one' }] }
        };
      }
    });

    const result = await tools[0].execute('call-1', { type: 'top' });

    expect(executions).toEqual([
      {
        pluginDir: '/plugins/hacker-news',
        pluginId: 'hacker-news',
        toolName: 'getStoryList',
        args: { type: 'top' },
        credentials: {}
      }
    ]);
    expect(result.content[0].text).toContain('Story one');
    expect(result.details.references).toHaveLength(1);
    expect(result.details.card.name.singular).toBe('story list');
  });

  describe('missing plugin credentials', () => {
    function weatherPlugin(overrides = {}) {
      return {
        id: 'open-weather',
        name: 'Open Weather',
        directory: '/plugins/open-weather',
        tools: [
          {
            name: 'weather_current',
            description: 'Fetch current weather.',
            parameters: { type: 'object', properties: { city: { type: 'string' } } },
            card: {
              name: { singular: 'forecast', plural: 'forecasts' },
              layout: [{ component: 'KeyValue', pairs: [{ label: 'City', field: 'city' }] }]
            }
          }
        ],
        ...overrides
      };
    }

    const declaredMissing = [
      {
        key: 'OPENWEATHER_API_KEY',
        label: 'OpenWeather API key',
        description: 'Free tier.',
        signupUrl: 'https://openweathermap.org/api'
      }
    ];

    it('ends the turn without spawning the plugin when a declared key is unset', async () => {
      const emitted = [];
      let called = false;
      const tools = createGeneratedPluginTools({
        Type,
        plugins: [weatherPlugin({ missingCredentials: declaredMissing })],
        executePluginTool: async () => {
          called = true;
          return {};
        },
        onCredentialRequest: (request) => emitted.push(request)
      });

      const result = await tools[0].execute('call-1', { city: 'Oslo' });

      expect(called).toBe(false);
      expect(result.terminate).toBe(true);
      expect(result.details).toMatchObject({
        type: 'credential-request',
        pluginId: 'open-weather',
        pluginName: 'Open Weather',
        credentials: declaredMissing
      });
      expect(result.content[0].text).toMatch(/Do not answer from general knowledge/);
      expect(emitted).toHaveLength(1);
    });

    it('passes resolved credentials through and runs normally', async () => {
      const executions = [];
      const tools = createGeneratedPluginTools({
        Type,
        plugins: [
          weatherPlugin({
            missingCredentials: [],
            credentialValues: { OPENWEATHER_API_KEY: 'secret-value' }
          })
        ],
        executePluginTool: async (request) => {
          executions.push(request);
          return {
            text: 'Sunny',
            references: [{ url: 'https://openweathermap.org' }],
            data: { city: 'Oslo' }
          };
        }
      });

      const result = await tools[0].execute('call-1', { city: 'Oslo' });

      expect(executions[0].credentials).toEqual({ OPENWEATHER_API_KEY: 'secret-value' });
      expect(result.terminate).toBeUndefined();
      expect(result.content[0].text).toContain('Sunny');
    });

    it('handles an undeclared credential surfaced only at runtime', async () => {
      const emitted = [];
      const tools = createGeneratedPluginTools({
        Type,
        plugins: [weatherPlugin()],
        executePluginTool: async () => {
          const error = new Error('Missing credential UNDECLARED_KEY.');
          error.credentialRequest = { key: 'UNDECLARED_KEY', label: 'Undeclared key' };
          throw error;
        },
        onCredentialRequest: (request) => emitted.push(request)
      });

      const result = await tools[0].execute('call-1', { city: 'Oslo' });

      expect(result.terminate).toBe(true);
      expect(result.details.credentials).toEqual([
        { key: 'UNDECLARED_KEY', label: 'Undeclared key', description: '', signupUrl: '' }
      ]);
      expect(emitted).toHaveLength(1);
    });

    it('lets ordinary tool failures keep propagating', async () => {
      const tools = createGeneratedPluginTools({
        Type,
        plugins: [weatherPlugin()],
        executePluginTool: async () => {
          throw new Error('Upstream API is down.');
        }
      });

      await expect(tools[0].execute('call-1', { city: 'Oslo' })).rejects.toThrow(
        'Upstream API is down.'
      );
    });
  });

  it('turns semantic build intent into a structured terminating tool result', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request));
    const result = await tool.execute('build-1', {
      name: 'Hacker News',
      description: 'Build a complete Hacker News API integration for research.',
      sourceUrls: ['https://github.com/HackerNews/API', 'not-a-url'],
      reason: 'No installed tool can access Hacker News.',
      taskKind: 'card-edit',
      targetTools: [' dnd_get_monster ', 'dnd_get_monster', 'dnd_get_spell']
    });

    expect(tool.name).toBe('request_plugin_build');
    expect(emitted).toEqual([
      {
        name: 'hacker-news',
        description: 'Build a complete Hacker News API integration for research.',
        sourceUrls: ['https://github.com/HackerNews/API'],
        reason: 'No installed tool can access Hacker News.',
        auth: undefined,
        taskKind: 'card-edit',
        targetTools: ['dnd_get_monster', 'dnd_get_spell']
      }
    ]);
    expect(result.terminate).toBe(true);
    expect(result.details.type).toBe('plugin-build-request');
  });

  it('carries an advance API-key notice so the user can register during the build', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request));
    await tool.execute('build-1', {
      name: 'open-weather',
      description: 'Current weather and forecasts.',
      reason: 'No installed tool can reach OpenWeather.',
      auth: {
        required: true,
        signupUrl: 'https://openweathermap.org/api',
        credentialLabel: 'OpenWeather API key'
      }
    });

    expect(emitted[0].auth).toEqual({
      required: true,
      signupUrl: 'https://openweathermap.org/api',
      credentialLabel: 'OpenWeather API key'
    });
  });

  it('drops an unusable sign-up link and omits auth when no key is needed', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request));

    await tool.execute('build-1', {
      name: 'open-weather',
      description: 'Weather.',
      reason: 'Missing capability.',
      auth: { required: true, signupUrl: 'not-a-url' }
    });
    expect(emitted[0].auth).toEqual({ required: true, signupUrl: '', credentialLabel: '' });

    await tool.execute('build-2', {
      name: 'hacker-news',
      description: 'Stories.',
      reason: 'Missing capability.',
      auth: { required: false }
    });
    expect(emitted[1].auth).toBeUndefined();
  });
});

describe('formatToolResult', () => {
  // Shaped like the real data360_get_data result that killed a turn: a small
  // readable summary buried under the card payload and the citation modal's
  // copy of the same rows.
  function bigResult() {
    const rows = Array.from({ length: 1000 }, (_, i) => ({
      period: String(1980 + (i % 44)),
      area: 'GBR',
      value: String(100000 + i),
      unit: 'PC_A',
      frequency: 'A',
      sex: '_T',
      age: '_T',
      urbanisation: '_T',
      latest: 'No'
    }));
    return {
      text: 'Data360 returned 1000 observations (6185 total matches); showing 100:\n1. 2010 | GBR | 100308 PC_A',
      references: [
        {
          referenceId: 'WB_WDI:SL_GDP',
          referenceLabel: 'GDP per person employed (WB_WDI_SL_GDP_PCAP_EM_KD)',
          referenceMeta: { sourceUrl: 'https://data360api.worldbank.org/data360/data?DATABASE_ID=WB_WDI' },
          compactContent: [{ type: 'text', text: 'x'.repeat(200) }],
          expandedContent: [{ type: 'json', title: 'Raw API payload', text: JSON.stringify(rows, null, 2) }]
        }
      ],
      data: { total: 6185, returned: 1000, rows },
      card: { name: { singular: 'observation', plural: 'observations' }, layout: [] }
    };
  }

  it('collapses a huge result to the summary the model can actually use', () => {
    const result = bigResult();
    const wholeResult = JSON.stringify(result, null, 2).length;
    const formatted = formatToolResult(result);

    expect(wholeResult).toBeGreaterThan(200000);
    expect(formatted.length).toBeLessThanOrEqual(MODEL_RESULT_BYTE_LIMIT);
    // The summary and its citation survive intact.
    expect(formatted).toContain('Data360 returned 1000 observations');
    expect(formatted).toContain('https://data360api.worldbank.org/data360/data?DATABASE_ID=WB_WDI');
    // The host-only payloads never reach the model.
    expect(formatted).not.toContain('Raw API payload');
    expect(formatted).not.toContain('expandedContent');
    expect(formatted).not.toContain('singular');
  });

  it('announces omitted data instead of dropping it silently', () => {
    const formatted = formatToolResult(bigResult());
    expect(formatted).toContain('Structured data omitted');
    expect(formatted).toMatch(/narrow the query/i);
  });

  it('keeps small structured data, since it costs nothing', () => {
    const formatted = formatToolResult({
      text: 'One monster.',
      references: [],
      data: { name: 'Aboleth', hit_points: 135 }
    });
    expect(formatted).toContain('One monster.');
    expect(formatted).toContain('"hit_points":135');
  });

  it('truncates a runaway summary with a notice rather than trusting it', () => {
    const formatted = formatToolResult({ text: 'y'.repeat(20000), references: [], data: {} });
    expect(formatted.length).toBeLessThanOrEqual(MODEL_RESULT_BYTE_LIMIT);
    expect(formatted).toContain('Summary truncated');
    expect(formatted).toContain('of 20000 characters');
  });

  it('caps citations and says how many it dropped', () => {
    const references = Array.from({ length: 25 }, (_, i) => ({
      referenceLabel: `Source ${i}`,
      referenceMeta: { sourceUrl: `https://example.com/${i}` }
    }));
    const formatted = formatToolResult({ text: 'Many sources.', references, data: {} });
    expect(formatted).toContain('[20] Source 19');
    expect(formatted).not.toContain('Source 20');
    expect(formatted).toContain('5 further source(s) omitted');
  });

  it('handles non-object and empty results without throwing', () => {
    expect(formatToolResult('plain text')).toBe('plain text');
    expect(formatToolResult(null)).toBe('');
    expect(typeof formatToolResult({ text: '', references: [], data: null })).toBe('string');
  });
});
