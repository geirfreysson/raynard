import { describe, expect, it } from 'vitest';
import {
  buildPiTypeFromSchema,
  buildMainAgentSystemPrompt,
  createBuildRequestTool,
  createGeneratedPluginTools,
  createModel,
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

  it('requires a tool call in the current turn before making API claims or claiming cards appeared', () => {
    const explore = buildMainAgentSystemPrompt({
      mode: 'explore',
      toolNames: ['fpl_search_players']
    });

    expect(explore).toMatch(/current turn/i);
    expect(explore).toMatch(/never narrate.*tool call/i);
    expect(explore).toMatch(/never claim.*card.*shown/i);
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
        args: { type: 'top' }
      }
    ]);
    expect(result.content[0].text).toContain('Story one');
    expect(result.details.references).toHaveLength(1);
    expect(result.details.card.name.singular).toBe('story list');
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
        taskKind: 'card-edit',
        targetTools: ['dnd_get_monster', 'dnd_get_spell']
      }
    ]);
    expect(result.terminate).toBe(true);
    expect(result.details.type).toBe('plugin-build-request');
  });
});
