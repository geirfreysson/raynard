import { describe, expect, it } from 'vitest';
import {
  assignCitationNumbers,
  buildPiTypeFromSchema,
  buildMainAgentSystemPrompt,
  createAvailableExtensionSearchTool,
  createBuildRequestTool,
  createCitationCounter,
  createDirectAnswerTool,
  createGeneratedPluginTools,
  createExtensionRecommendationTool,
  createModel,
  createScheduledTaskTool,
  createUsageTotal,
  addUsage,
  emptyUsage,
  extractAssistantText,
  resolveContextWindow,
  defaultThinkingLevel,
  inferReasoningSupport,
  formatToolResult,
  isTransientModelError,
  MODEL_RESULT_BYTE_LIMIT,
  retryAfterMs,
  runWithTransientResume,
  toAgentMessages,
  transientReason
} from './main-agent-core.mjs';
import { Type } from '@mariozechner/pi-ai';

describe('main agent core', () => {
  it('keeps Markdown block boundaries between separate assistant text blocks', () => {
    const text = extractAssistantText({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will fetch the remaining countries:' },
        { type: 'toolCall', id: 'call-1', name: 'query', arguments: {} },
        {
          type: 'text',
          text: '```chart\n{"type":"bar","x":"country","series":[{"key":"value"}],"rows":[{"country":"Iceland","value":1}]}\n```'
        }
      ]
    });

    expect(text).toContain('countries:\n\n```chart');
  });

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

  it('takes real context and output limits from the model catalog', () => {
    // A hardcoded 8192 output cap killed a build mid-file: a thinking model
    // spends that budget on reasoning before it can write anything large.
    const known = createModel({
      provider: 'moonshot',
      model: 'kimi-k2-thinking',
      baseUrl: 'https://api.moonshot.ai/v1'
    });
    expect(known.contextWindow).toBe(262144);
    expect(known.maxTokens).toBeGreaterThanOrEqual(32768);
    expect(known.reasoning).toBe(true);

    // Models newer than the pinned catalog still must not fall back to 8192.
    const unknown = createModel({
      provider: 'moonshot',
      model: 'kimi-k3',
      baseUrl: 'https://api.moonshot.ai/v1'
    });
    expect(unknown.contextWindow).toBeGreaterThanOrEqual(262144);
    expect(unknown.maxTokens).toBeGreaterThanOrEqual(32768);
  });

  it('routes the ChatGPT subscription provider to the Codex responses API', () => {
    // OAuth access tokens only work against chatgpt.com/backend-api, which
    // speaks a different wire format than the api.openai.com Responses API.
    const model = createModel({
      provider: 'openai-codex',
      model: 'gpt-5.5',
      baseUrl: 'https://chatgpt.com/backend-api'
    });

    expect(model).toMatchObject({
      id: 'gpt-5.5',
      api: 'openai-codex-responses',
      provider: 'openai-codex',
      baseUrl: 'https://chatgpt.com/backend-api'
    });
    expect(model.contextWindow).toBe(272000);
    expect(model.reasoning).toBe(true);

    // A Codex model newer than the pinned catalog must not drop to the
    // 128k/16k default: these are all large-context reasoning models.
    const unknownCodex = createModel({
      provider: 'openai-codex',
      model: 'gpt-6-codex',
      baseUrl: 'https://chatgpt.com/backend-api'
    });
    expect(unknownCodex.api).toBe('openai-codex-responses');
    expect(unknownCodex.contextWindow).toBeGreaterThanOrEqual(272000);
    expect(unknownCodex.maxTokens).toBeGreaterThanOrEqual(128000);
  });

  it('marks an unfinished plugin so the agent resumes it instead of forking a name', () => {
    // A failed build left "openweathermap" scaffolded with zero tools. The
    // agent could not tell it apart from a finished plugin, so it asked for
    // "openweathermap-onecall" and orphaned 22 KB of working code.
    const prompt = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['hn_top'],
      plugins: [
        { slug: 'hacker-news', name: 'Hacker News', toolCount: 5 },
        { slug: 'openweathermap', name: 'Openweathermap', toolCount: 0 }
      ]
    });

    expect(prompt).toContain('hacker-news ("Hacker News") — 5 tools');
    expect(prompt).toContain('openweathermap ("Openweathermap") — UNFINISHED BUILD');
    expect(prompt).toMatch(/pass its exact slug so the build resumes in place/i);
    expect(prompt).toMatch(/never pick a new or suffixed name/i);
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

  it('routes recurring work to the host scheduling tool and disables recursion during runs', () => {
    const enabled = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['oecd_data'],
      scheduling: {
        enabled: true,
        localDateTime: '2026-08-23T14:30:00Z',
        timeZone: 'Europe/London',
        currentChatId: 'chat-one',
        chats: [{ id: 'chat-one', name: 'Inflation research' }]
      }
    });
    const execution = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['oecd_data'],
      scheduling: { enabled: false }
    });

    expect(enabled).toMatch(/FIRST and ONLY tool call is request_scheduled_task/);
    expect(enabled).toContain('chat-one: Inflation research');
    expect(execution).toMatch(/already a scheduled execution/i);
    expect(execution).toMatch(/never create another scheduled task/i);
  });

  it('normalizes a quarterly scheduling request into a terminating draft', async () => {
    const requests = [];
    const tool = createScheduledTaskTool(Type, (request) => requests.push(request), {
      context: {
        localDateTime: '2026-08-23T14:30:00Z',
        timeZone: 'Europe/London',
        chats: [{ id: 'chat-one', name: 'Inflation research' }]
      }
    });
    const result = await tool.execute('schedule-1', {
      name: 'Iceland inflation comparison',
      prompt: 'Check Iceland inflation and compare it with the OECD.',
      frequency: 'quarterly'
    });

    expect(tool.name).toBe('request_scheduled_task');
    expect(result.terminate).toBe(true);
    expect(requests).toEqual([
      expect.objectContaining({
        destinationType: 'newChat',
        schedule: expect.objectContaining({
          frequency: 'quarterly',
          timeZone: 'Europe/London',
          dayOfMonth: 23,
          monthOfYear: 8
        })
      })
    ]);
  });

  it('clarifies the data source instead of proposing a plugin without a credible API', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['hn_top', 'openweather_forecast'],
      plugins: [
        { slug: 'hacker-news', name: 'Hacker News', toolCount: 1 },
        { slug: 'open-weather', name: 'OpenWeather', toolCount: 1 }
      ]
    });

    expect(explore).toMatch(/do not call request_plugin_build/i);
    expect(explore).toMatch(/credible.*API|API.*credible/i);
    expect(explore).toMatch(/where.*information.*come from/i);
    expect(explore).toMatch(/suggest.*public APIs/i);
    expect(explore).toMatch(/installed (plugins|tools)/i);
    expect(explore).toMatch(/answer_without_api.*clarif/i);
  });

  it('checks available extensions on demand without embedding their catalog in the default prompt', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: [],
      plugins: []
    });

    expect(explore).toMatch(/call search_available_extensions.*before.*answer_without_api/is);
    expect(explore).toContain('Or provide me with an API documentation site and I can build one.');
    expect(explore).not.toContain('Open Library');
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
    expect(explore).toContain('"rightYLabel"');
    expect(explore).toContain('series[].axis');
    expect(explore).toMatch(/different units.*currency.*percentage/is);
    expect(explore).toMatch(/never claim.*two axes.*yLabel/is);
    expect(explore).toMatch(/yLabel.*rightYLabel.*2.?5 words.*30 characters/is);
    expect(explore).toMatch(/line charts.*data-relative.*bar charts.*zero baseline/is);
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

  it('allows a source clarification without pretending to answer the data question', () => {
    const tool = createDirectAnswerTool(Type, () => {});

    expect(tool.description).toMatch(/clarif/i);
    expect(tool.description).toMatch(/data source|API source/i);
    expect(tool.description).toMatch(/installed (plugins|tools)/i);
  });

  it('makes the agent disclose which candidate it chose over which alternative', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['data360_search_indicators', 'ol_search_editions']
    });

    // A silent pick between plausible candidates reads as arbitrary: name the
    // one used, why it won, and the closest one rejected.
    expect(explore).toMatch(/several candidates that could each plausibly have answered/i);
    expect(explore).toMatch(/name the one you used, the reason it won, and the closest one you did not use/i);
    // Bounded output, so this stays a note rather than a section.
    expect(explore).toMatch(/one or two sentences at the end/i);
    // The exemption is what keeps the note off ordinary single-candidate lookups.
    expect(explore).toMatch(/only one was a real candidate, or when the user named it/i);
    // Carve-out against the "no internal detail" rule: the identifier is the
    // handle a reader needs to ask for the other candidate.
    expect(explore).toMatch(/source's own identifier for a candidate is not internal detail/i);

    // The rule must stay source-agnostic: no single extension's vocabulary
    // baked into a prompt that also serves books, football, and monsters.
    expect(explore).not.toMatch(/SI\.POV\.GINI|OECD_IDD|WB_WDI_/);
    expect(explore).toMatch(/rival datasets, definitions, editions, or providers/i);
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
          data: { stories: [{ title: 'Story one' }] },
          _raynard: { cacheHit: true }
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
    expect(result.details._raynard).toEqual({ cacheHit: true });
  });

  it('numbers citations across every tool call in one turn, for the host too', async () => {
    const definition = {
      name: 'fetch',
      description: 'Fetch data.',
      parameters: { type: 'object', properties: {} },
      card: { name: { singular: 'row', plural: 'rows' }, layout: [] }
    };
    let call = 0;
    const tools = createGeneratedPluginTools({
      Type,
      plugins: [{ id: 'p', directory: '/plugins/p', tools: [definition] }],
      executePluginTool: async () => {
        call += 1;
        return {
          text: `Call ${call}`,
          references:
            call === 1
              ? [{ referenceLabel: 'A' }, { referenceLabel: 'B' }]
              : [{ referenceLabel: 'C' }],
          data: {}
        };
      }
    });

    const first = await tools[0].execute('call-1', {});
    const second = await tools[0].execute('call-2', {});

    // The model's markers and the host's stored references are the same numbers.
    expect(first.content[0].text).toContain('[^1] A');
    expect(first.content[0].text).toContain('[^2] B');
    expect(second.content[0].text).toContain('[^3] C');
    expect(first.details.references.map((reference) => reference.citationNumber)).toEqual([1, 2]);
    expect(second.details.references[0].citationNumber).toBe(3);
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

  it('searches only uninstalled catalog extensions after a missing-capability decision', async () => {
    const tool = createAvailableExtensionSearchTool(Type, [
      {
        slug: 'open-library',
        name: 'Open Library',
        description: 'Search books and retrieve editions and authors.',
        category: 'Books',
        installed: false,
        tools: [{ name: 'open_library_search_books', description: 'Search for books.' }]
      },
      {
        slug: 'hacker-news',
        name: 'Hacker News',
        description: 'Read technology stories.',
        category: 'News',
        installed: true,
        tools: [{ name: 'hn_top_stories', description: 'Read top stories.' }]
      }
    ]);

    const result = await tool.execute('catalog-1', { query: 'find books by author' });

    expect(tool.name).toBe('search_available_extensions');
    expect(result.content[0].text).toContain('Open Library');
    expect(result.content[0].text).toContain('open_library_search_books');
    expect(result.content[0].text).not.toContain('Hacker News');
    expect(result.content[0].text).toContain(
      'Or provide me with an API documentation site and I can build one.'
    );
    expect(result.details.extensions.map((extension) => extension.slug)).toEqual([
      'open-library'
    ]);
  });

  it('turns a catalog choice into a structured install recommendation', async () => {
    const emitted = [];
    const tool = createExtensionRecommendationTool(
      Type,
      [
        {
          slug: 'open-library',
          name: 'Open Library',
          description: 'Search books and authors.',
          installed: false
        }
      ],
      (recommendation) => emitted.push(recommendation)
    );

    const result = await tool.execute('recommend-1', {
      slug: 'open-library',
      answer: 'The Open Library extension can search books and authors.'
    });

    expect(tool.name).toBe('recommend_available_extension');
    expect(result.terminate).toBe(true);
    expect(emitted).toEqual([
      {
        slug: 'open-library',
        name: 'Open Library',
        description: 'Search books and authors.',
        answer:
          'The Open Library extension can search books and authors.\n\nOr provide me with an API documentation site and I can build one.'
      }
    ]);
  });

  it('rejects a new-plugin proposal that has no credible API source', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request));
    const result = await tool.execute('build-1', {
      name: 'mystery-data',
      description: 'Retrieve unspecified information.',
      reason: 'No installed tool can answer the question.',
      taskKind: 'plugin-create'
    });

    expect(emitted).toEqual([]);
    expect(result.terminate).toBe(false);
    expect(result.details.type).toBe('plugin-build-request-rejected');
    expect(result.content[0].text).toMatch(/ask.*source|where.*come from/i);
  });

  it('still allows a source-less edit to an actually installed plugin', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request), {
      installedPluginNames: ['hacker-news']
    });
    const result = await tool.execute('build-1', {
      name: 'hacker-news',
      description: 'Make the story card title larger.',
      reason: 'The installed card needs a presentation change.',
      taskKind: 'card-edit',
      targetTools: ['hn_top']
    });

    expect(emitted).toHaveLength(1);
    expect(result.terminate).toBe(true);
    expect(result.details.type).toBe('plugin-build-request');
  });

  it('rejects a source-less edit label for a plugin that is not installed', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request), {
      installedPluginNames: ['hacker-news']
    });
    const result = await tool.execute('build-1', {
      name: 'made-up-plugin',
      description: 'Add access to an unspecified source.',
      reason: 'The capability is missing.',
      taskKind: 'plugin-edit'
    });

    expect(emitted).toEqual([]);
    expect(result.details.reason).toBe('missing-api-source');
  });

  it('carries an advance API-key notice so the user can register during the build', async () => {
    const emitted = [];
    const tool = createBuildRequestTool(Type, (request) => emitted.push(request));
    await tool.execute('build-1', {
      name: 'open-weather',
      description: 'Current weather and forecasts.',
      sourceUrls: ['https://openweathermap.org/api'],
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
      sourceUrls: ['https://openweathermap.org/api'],
      reason: 'Missing capability.',
      auth: { required: true, signupUrl: 'not-a-url' }
    });
    expect(emitted[0].auth).toEqual({ required: true, signupUrl: '', credentialLabel: '' });

    await tool.execute('build-2', {
      name: 'hacker-news',
      description: 'Stories.',
      sourceUrls: ['https://github.com/HackerNews/API'],
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
    expect(formatted).toContain('[^20] Source 19');
    expect(formatted).not.toContain('Source 20');
    expect(formatted).toContain('5 further source(s) omitted');
  });

  it('lists citations under the numbers the turn assigned', () => {
    const counter = createCitationCounter();
    const first = { text: 'a', references: [{ referenceLabel: 'A' }], data: {} };
    const second = { text: 'b', references: [{ referenceLabel: 'B' }], data: {} };
    assignCitationNumbers(first, counter);
    assignCitationNumbers(second, counter);

    expect(formatToolResult(first)).toContain('[^1] A');
    // The second call continues the turn's numbering rather than restarting.
    expect(formatToolResult(second)).toContain('[^2] B');
  });
});

describe('assignCitationNumbers', () => {
  it('numbers every reference across calls so a marker means one thing', () => {
    const counter = createCitationCounter();
    const search = { references: [{ referenceLabel: 'A' }, { referenceLabel: 'B' }] };
    const fetch = { references: [{ referenceLabel: 'C' }] };

    assignCitationNumbers(search, counter);
    assignCitationNumbers(fetch, counter);

    expect(search.references.map((reference) => reference.citationNumber)).toEqual([1, 2]);
    expect(fetch.references[0].citationNumber).toBe(3);
  });

  it('ignores results that carry no references', () => {
    const counter = createCitationCounter();
    assignCitationNumbers({ text: 'no refs' }, counter);
    assignCitationNumbers(null, counter);
    assignCitationNumbers('plain', counter);

    expect(counter.next).toBe(1);
  });

  it('handles non-object and empty results without throwing', () => {
    expect(formatToolResult('plain text')).toBe('plain text');
    expect(formatToolResult(null)).toBe('');
    expect(typeof formatToolResult({ text: '', references: [], data: null })).toBe('string');
  });
});

describe('transient model errors', () => {
  it('treats provider capacity and availability failures as retryable', () => {
    // The exact Moonshot string that killed a 13-tool-call turn.
    expect(
      isTransientModelError('429 The engine is currently overloaded, please try again later')
    ).toBe(true);
    expect(isTransientModelError('503 Service Unavailable')).toBe(true);
    expect(isTransientModelError('500 Internal Server Error')).toBe(true);
    expect(isTransientModelError('Rate limit reached for requests')).toBe(true);
    expect(isTransientModelError('The server is temporarily unavailable')).toBe(true);
    expect(isTransientModelError('Request timed out')).toBe(true);
  });

  it('never retries failures that another attempt cannot fix', () => {
    expect(isTransientModelError('401 Invalid Authentication')).toBe(false);
    expect(isTransientModelError('403 Forbidden')).toBe(false);
    expect(isTransientModelError('Incorrect API key provided')).toBe(false);
    expect(
      isTransientModelError("400 This model's maximum context length is 262144 tokens")
    ).toBe(false);
    expect(isTransientModelError('')).toBe(false);
    expect(isTransientModelError(undefined)).toBe(false);
  });

  it('does not mistake a plugin tool failure for a provider failure', () => {
    // Tool errors arrive on their own channel and must never trigger a resume.
    expect(isTransientModelError('Tool failed: eia_series_search returned 404')).toBe(false);
  });

  it('names the reason so the status line can say what is wrong', () => {
    expect(transientReason('429 The engine is currently overloaded')).toBe('overloaded');
    expect(transientReason('429 Rate limit reached for requests')).toBe('rate_limited');
    expect(transientReason('503 Service Unavailable')).toBe('unavailable');
    expect(transientReason('Request timed out')).toBe('timeout');
    expect(transientReason('401 Invalid Authentication')).toBe(null);
  });

  // A stand-in for Pi's Agent: `continue()` replays the next scripted outcome
  // onto the transcript exactly as the real loop does.
  function fakeAgent(outcomes, transcript) {
    const messages = transcript ?? [
      { role: 'user', content: 'question' },
      { role: 'assistant', content: [{ type: 'toolCall' }] },
      { role: 'toolResult', content: 'rows' }
    ];
    const agent = {
      state: { messages },
      round: { stopReason: '', errorMessage: '' },
      continues: 0,
      async continue() {
        agent.continues += 1;
        const outcome = outcomes.shift() || { stopReason: 'stop' };
        agent.round = { stopReason: outcome.stopReason, errorMessage: outcome.errorMessage || '' };
        messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: outcome.text || '' }],
          stopReason: outcome.stopReason,
          errorMessage: outcome.errorMessage
        });
      }
    };
    return agent;
  }

  function resumeHarness(agent) {
    const resumes = [];
    return {
      resumes,
      run: () =>
        runWithTransientResume({
          agent,
          start: () => agent.continue(),
          readFailure: () => agent.round,
          onResume: (event) => resumes.push(event),
          wait: async () => {}
        })
    };
  }

  it('resumes an overloaded round without discarding earlier tool work', async () => {
    const agent = fakeAgent([
      { stopReason: 'error', errorMessage: '429 The engine is currently overloaded' },
      { stopReason: 'stop', text: 'Here are the prices.' }
    ]);
    const harness = resumeHarness(agent);

    const { resumeAttempts } = await harness.run();

    expect(resumeAttempts).toBe(1);
    expect(harness.resumes[0]).toMatchObject({ reason: 'overloaded', attempt: 1, maxAttempts: 3 });
    // The failed round is gone and the tool result it followed is still there.
    expect(agent.state.messages.filter((message) => message.stopReason === 'error')).toHaveLength(0);
    expect(agent.state.messages.some((message) => message.role === 'toolResult')).toBe(true);
    expect(agent.round.stopReason).toBe('stop');
  });

  it('gives up after the attempt budget and leaves the failure for the caller', async () => {
    const failure = { stopReason: 'error', errorMessage: '429 overloaded' };
    const agent = fakeAgent([failure, { ...failure }, { ...failure }, { ...failure }]);
    const harness = resumeHarness(agent);

    const { resumeAttempts } = await harness.run();

    expect(resumeAttempts).toBe(3);
    expect(harness.resumes.map((event) => event.attempt)).toEqual([1, 2, 3]);
    expect(agent.round.stopReason).toBe('error');
  });

  it('does not resume a failure another attempt cannot fix', async () => {
    const agent = fakeAgent([
      { stopReason: 'error', errorMessage: '401 Invalid Authentication' }
    ]);
    const harness = resumeHarness(agent);

    expect(await harness.run()).toEqual({ resumeAttempts: 0 });
    expect(harness.resumes).toHaveLength(0);
  });

  it('does not resume a cancelled turn', async () => {
    const agent = fakeAgent([{ stopReason: 'aborted', errorMessage: '' }]);
    const harness = resumeHarness(agent);

    expect(await harness.run()).toEqual({ resumeAttempts: 0 });
  });

  it('backs off longer each attempt unless the provider names a delay', async () => {
    const agent = fakeAgent([
      { stopReason: 'error', errorMessage: '429 overloaded' },
      { stopReason: 'error', errorMessage: '429 overloaded, retry-after: 7' },
      { stopReason: 'stop' }
    ]);
    const harness = resumeHarness(agent);

    await harness.run();

    expect(harness.resumes.map((event) => event.delayMs)).toEqual([2_000, 7_000]);
  });

  it('surfaces the failure when the transcript cannot be resumed from', async () => {
    // No tool result or user message under the failed round: continuing would
    // throw, so the error has to reach the user instead.
    const agent = fakeAgent([{ stopReason: 'error', errorMessage: '429 overloaded' }], [
      { role: 'assistant', content: [{ type: 'text', text: 'stale' }] }
    ]);
    const harness = resumeHarness(agent);

    expect(await harness.run()).toEqual({ resumeAttempts: 0 });
    expect(agent.continues).toBe(1);
  });

  it('prefers a server-requested delay over our own backoff', () => {
    expect(retryAfterMs('429 slow down, retry-after: 12')).toBe(12_000);
    expect(retryAfterMs('429 please try again in 4.5s')).toBe(4_500);
    expect(retryAfterMs('429 The engine is currently overloaded')).toBe(null);
    // A server asking for longer than we are willing to wait is ignored.
    expect(retryAfterMs('429 retry-after: 600')).toBe(null);
  });
});

describe('reasoning support', () => {
  it('recognizes the reasoning families the catalog may not know yet', () => {
    expect(inferReasoningSupport('openai', 'gpt-5.2')).toBe(true);
    expect(inferReasoningSupport('openai', 'o3-mini')).toBe(true);
    expect(inferReasoningSupport('openai-codex', 'gpt-5-codex')).toBe(true);
    expect(inferReasoningSupport('moonshot', 'kimi-k2.5')).toBe(true);
    expect(inferReasoningSupport('claude', 'claude-opus-5')).toBe(true);
  });

  it('does not claim reasoning for models that lack it', () => {
    // gpt-4o would match a naive /o/ test and must not.
    expect(inferReasoningSupport('openai', 'gpt-4o')).toBe(false);
    expect(inferReasoningSupport('openai', 'gpt-3.5-turbo')).toBe(false);
    expect(inferReasoningSupport('moonshot', 'moonshot-v1-8k')).toBe(false);
    expect(inferReasoningSupport('someone-else', 'mystery-model')).toBe(false);
    expect(inferReasoningSupport('openai', '')).toBe(false);
  });

  it('prefers the catalog and only infers when it misses', () => {
    // A known non-reasoning model must stay false even though inference would
    // never be consulted for it.
    const unknown = createModel({
      provider: 'openai',
      model: 'gpt-5.9-imaginary',
      baseUrl: 'https://api.openai.com/v1'
    });
    expect(unknown.reasoning).toBe(true);

    const unknownPlain = createModel({
      provider: 'openai',
      model: 'gpt-4o-imaginary',
      baseUrl: 'https://api.openai.com/v1'
    });
    expect(unknownPlain.reasoning).toBe(false);
  });

  it('asks the builder to think harder than an ordinary chat turn', () => {
    // "off" is what made GPT send effort:"none" and stream no summaries.
    expect(defaultThinkingLevel('explore')).not.toBe('off');
    expect(defaultThinkingLevel('build')).not.toBe('off');
    expect(defaultThinkingLevel('build')).toBe('medium');
    expect(defaultThinkingLevel('explore')).toBe('low');
  });
});

describe('token usage accounting', () => {
  it('starts empty', () => {
    expect(emptyUsage()).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0
    });
  });

  it('sums usage across the rounds of one turn instead of overwriting', () => {
    // A turn with a tool call produces two assistant messages. Taking only the
    // last one would report the tool round and lose the first model call.
    const total = createUsageTotal();
    total.add({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1, totalTokens: 126 });
    total.add({ input: 300, output: 40, cacheRead: 7, cacheWrite: 2, totalTokens: 349 });

    expect(total.value()).toMatchObject({
      input: 400,
      output: 60,
      cacheRead: 12,
      cacheWrite: 3,
      totalTokens: 475,
      rounds: 2
    });
  });

  it('reports context fill from the last round only, never the running sum', () => {
    // Each tool round resends the whole conversation. Summing input would put a
    // healthy chat past 100% of the window, so the meter tracks the last round.
    const total = createUsageTotal(200000);
    total.add({ input: 10000, output: 200, cacheRead: 0, cacheWrite: 0 });
    total.add({ input: 12000, output: 300, cacheRead: 500, cacheWrite: 0 });

    const value = total.value();
    expect(value.contextTokens).toBe(12800);
    expect(value.contextWindow).toBe(200000);
    // The cumulative spend is still available, and is deliberately larger.
    expect(value.totalTokens).toBe(23000);
    expect(value.contextTokens).toBeLessThan(value.totalTokens);
  });

  it('prefers a reported totalTokens for context fill, as pi does', () => {
    // Some providers report totalTokens and leave the parts at zero. Summing
    // parts alone would show an empty meter on a full conversation.
    const total = createUsageTotal(200000);
    total.add({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 90_000 });

    expect(total.value().contextTokens).toBe(90_000);
  });

  it('does not let an aborted round empty the context meter', () => {
    const total = createUsageTotal(200000);
    total.add({ input: 150_000, output: 400, cacheRead: 0, cacheWrite: 0 });
    // A cancelled or failed round reports nothing; the window is still full.
    total.add({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });

    expect(total.value().contextTokens).toBe(150_400);
  });

  it('carries the context window through so the renderer never guesses it', () => {
    expect(createUsageTotal(262144).value().contextWindow).toBe(262144);
    expect(createUsageTotal().value().contextWindow).toBe(0);
  });

  it('keeps counting across a retry, which resetRound must not clear', () => {
    const total = createUsageTotal();
    total.add({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 });
    // runWithTransientResume restarts the round; the tokens already billed by
    // the failed attempt were still charged and must survive.
    total.add({ input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 });

    expect(total.value().totalTokens).toBe(220);
  });

  it('derives totalTokens when the provider omits it', () => {
    const total = createUsageTotal();
    total.add({ input: 30, output: 12, cacheRead: 4, cacheWrite: 2 });

    expect(total.value().totalTokens).toBe(48);
  });

  it('ignores missing, partial, and non-numeric usage rather than producing NaN', () => {
    const total = createUsageTotal();
    total.add(undefined);
    total.add(null);
    total.add({});
    total.add({ input: 'lots', output: Number.NaN, totalTokens: 5 });
    total.add({ input: 10 });

    expect(total.value()).toMatchObject({
      input: 10,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15
    });
    expect(Number.isNaN(total.value().contextTokens)).toBe(false);
  });

  it('adds two usage blocks without mutating either', () => {
    const a = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10 };
    const b = { input: 5, output: 6, cacheRead: 7, cacheWrite: 8, totalTokens: 26 };
    const sum = addUsage(a, b);

    expect(sum).toEqual({ input: 6, output: 8, cacheRead: 10, cacheWrite: 12, totalTokens: 36 });
    expect(a.input).toBe(1);
    expect(b.input).toBe(5);
  });
});

describe('resolveContextWindow', () => {
  it('matches the context window the model is actually built with', () => {
    for (const provider of ['claude', 'moonshot', 'openai', 'openai-codex']) {
      const model = createModel({ provider, model: 'some-model', baseUrl: 'https://example.test' });
      expect(resolveContextWindow(provider, 'some-model')).toBe(model.contextWindow);
    }
  });

  it('falls back for an unknown provider', () => {
    expect(resolveContextWindow('nobody', 'nothing')).toBe(128000);
  });

  it('tolerates missing arguments', () => {
    expect(resolveContextWindow('', '')).toBe(128000);
    expect(resolveContextWindow(undefined, undefined)).toBe(128000);
  });
});
