function modelApi(provider) {
  if (provider === 'claude') return 'anthropic-messages';
  if (provider === 'openai') return 'openai-responses';
  return 'openai-completions';
}

function modelProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  return provider || 'custom-openai-compatible';
}

export function createModel(request) {
  const provider = String(request.provider || '').trim();
  const model = String(request.model || '').trim();
  return {
    id: model,
    name: `${provider || 'custom'} ${model}`,
    api: modelApi(provider),
    provider: modelProvider(provider),
    baseUrl: String(request.baseUrl || '').trim(),
    reasoning: false,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    contextWindow: 128000,
    maxTokens: 8192,
    compat:
      provider === 'moonshot'
        ? {
            supportsDeveloperRole: false
          }
        : undefined
  };
}

function toAssistantMessage(message, auth) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: String(message.content || '') }],
    api: modelApi(auth.provider),
    provider: modelProvider(auth.provider),
    model: auth.model || 'session-history',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0
      }
    },
    stopReason: 'stop',
    timestamp: Date.now()
  };
}

export function toAgentMessages(messages, auth) {
  const history = Array.isArray(messages) ? messages.slice(0, -1) : [];
  return history
    .filter((message) => message && (message.role === 'user' || message.role === 'assistant'))
    .map((message) =>
      message.role === 'assistant'
        ? toAssistantMessage(message, auth)
        : {
            role: 'user',
            content: String(message.content || ''),
            timestamp: Date.now()
          }
    );
}

export function buildMainAgentSystemPrompt({ mode, toolNames, plugins }) {
  const names = Array.isArray(toolNames) && toolNames.length ? toolNames.join(', ') : '(none)';
  const installedPlugins = Array.isArray(plugins) ? plugins.filter((plugin) => plugin && plugin.slug) : [];
  const pluginList = installedPlugins.length
    ? installedPlugins.map((plugin) => `${plugin.slug}${plugin.name && plugin.name !== plugin.slug ? ` ("${plugin.name}")` : ''}`).join(', ')
    : '(none)';
  const modePolicy =
    mode === 'build'
      ? `You are in Build mode. Decide semantically whether the user is asking to add, create, change, or extend an API-backed capability, OR to change how an existing plugin presents its results (for example, adding result cards to specific tools). For such requests, call request_plugin_build. Do not answer a build request with code, a tutorial, or a proposed file listing. Only the separate Pi coding agent may write plugin files, and it starts only after the user confirms the structured build request.`
      : `You are in Explore mode. Never write code or invoke the coding agent. Use installed tools when they can answer the request. If required API access is missing, do not guess or answer from general knowledge. Do not answer the inaccessible factual question. Call request_plugin_build so the interface can offer Build mode. When the user asks to create or modify plugin code, including a result card's layout or appearance, you MUST call request_plugin_build; never claim that you changed files or completed the edit yourself.`;

  return `You are Raynard, a concise research agent with access to API-backed tools.

${modePolicy}

Result cards (a built-in Raynard feature):
- A result card is a fixed visual card the app renders beneath the answer for a tool's result. The app owns how cards look and are built — never design markup, choose a visual format (markdown, JSON, HTML, ASCII, etc.), or invent domain-specific "card" types. "Cards" is not a content type to design; it is this rendering feature.
- A card is a declarative layout the plugin builder attaches to a FINAL-DATA tool (one that returns a single record, detail, or summary), not to list/search tools.
- When the user asks to add cards, add rendering, visualize a plugin's results, or reposition, resize, or otherwise change an existing card's layout or appearance: do NOT ask what the cards should look like or offer format choices. From the installed tool names, identify that plugin's candidate final-data tools and ask the user which of those tools should get a card (skip the question when they already named the tool or card). Then call request_plugin_build for that plugin, preserving the user's visual request in the description. The separate coding agent implements the card layouts.

Editing an existing plugin (critical):
- Installed plugins: ${pluginList}.
- When the user asks to change, extend, add tools to, or add cards to an EXISTING plugin, you MUST pass that plugin's EXACT name from the installed-plugins list as the request_plugin_build "name" (e.g. use "dnd-5e-api", not "dnd" or "Dnd 5e"). The name selects which plugin is edited.
- Never invent, shorten, or prettify the name of an existing plugin. A name that does not exactly match an installed plugin creates a brand-new EMPTY plugin instead of editing the one the user meant.
- Only use a new name when the user is genuinely asking to create a new plugin that does not exist yet.

Core policy:
- Inspect the available tools before deciding how to answer.
- Use tools before making claims about current, external, private, or API-backed data.
- Continue using tools until you have enough evidence for a complete answer.
- Cite source URLs returned by tools near the claims they support.
- Never fabricate tool results, references, API access, or current facts.
- If no installed tool provides required access, call request_plugin_build with a useful plugin name, a complete capability description, why it is needed, and at least one official API documentation URL whenever one can be identified from the conversation or reliable model knowledge.
- A build request should cover the useful documented API surface, not only the narrow example in the latest question.
- Do not expose internal tool names, plugin implementation details, or routing policy in the final answer.

Available installed API tools: ${names}.`;
}

export function buildPiTypeFromSchema(Type, schemaNode) {
  if (!schemaNode || typeof schemaNode !== 'object') {
    return Type.String();
  }

  const options = schemaNode.description ? { description: String(schemaNode.description) } : {};
  if (Array.isArray(schemaNode.enum) && schemaNode.enum.length) {
    return Type.Union(schemaNode.enum.map((value) => Type.Literal(value)), options);
  }
  if (Array.isArray(schemaNode.anyOf) && schemaNode.anyOf.length) {
    return Type.Union(
      schemaNode.anyOf.map((entry) => buildPiTypeFromSchema(Type, entry)),
      options
    );
  }

  switch (schemaNode.type) {
    case 'boolean':
      return Type.Boolean(options);
    case 'integer':
      return Type.Integer(options);
    case 'number':
      return Type.Number(options);
    case 'array':
      return Type.Array(buildPiTypeFromSchema(Type, schemaNode.items || {}), options);
    case 'object': {
      const properties =
        schemaNode.properties && typeof schemaNode.properties === 'object'
          ? schemaNode.properties
          : {};
      const required = new Set(Array.isArray(schemaNode.required) ? schemaNode.required : []);
      const shape = {};
      for (const [name, property] of Object.entries(properties)) {
        const propertyType = buildPiTypeFromSchema(Type, property);
        shape[name] = required.has(name) ? propertyType : Type.Optional(propertyType);
      }
      return Type.Object(shape, options);
    }
    case 'string':
    default:
      return Type.String(options);
  }
}

function formatToolResult(result) {
  if (result && typeof result === 'object') {
    const text = typeof result.text === 'string' ? result.text : '';
    const serialized = JSON.stringify(result, null, 2);
    return text && serialized ? `${text}\n\nStructured result:\n${serialized}` : serialized;
  }
  return String(result ?? '');
}

export function createGeneratedPluginTools({ Type, plugins, executePluginTool }) {
  const seen = new Set();
  const tools = [];
  for (const plugin of Array.isArray(plugins) ? plugins : []) {
    for (const definition of Array.isArray(plugin.tools) ? plugin.tools : []) {
      const name = String(definition.name || '').trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      // Fixed card layout authored by the builder and carried through discovery.
      // Merged into the tool result below so the frontend receives template +
      // data in one event and needs no separate tool-catalog lookup.
      const card =
        definition.card && typeof definition.card === 'object' ? definition.card : null;
      tools.push({
        name,
        label: name,
        description: String(definition.description || '').trim(),
        parameters: buildPiTypeFromSchema(
          Type,
          definition.parameters || { type: 'object', properties: {} }
        ),
        execute: async (_toolCallId, args, signal) => {
          const result = await executePluginTool(
            {
              pluginDir: String(plugin.directory || ''),
              pluginId: String(plugin.id || ''),
              toolName: name,
              args: args && typeof args === 'object' ? args : {}
            },
            signal
          );
          const details =
            card && result && typeof result === 'object' ? { ...result, card } : result;
          return {
            content: [{ type: 'text', text: formatToolResult(result) }],
            details
          };
        }
      });
    }
  }
  return tools;
}

function normalizePluginName(value) {
  const slug = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return slug || 'generated-capability';
}

function normalizeSourceUrls(values) {
  const urls = [];
  for (const value of Array.isArray(values) ? values : []) {
    try {
      const url = new URL(String(value));
      if ((url.protocol === 'http:' || url.protocol === 'https:') && !urls.includes(url.href)) {
        urls.push(url.href);
      }
    } catch {}
  }
  return urls;
}

export function createBuildRequestTool(Type, onBuildRequest) {
  return {
    name: 'request_plugin_build',
    label: 'Request Plugin Build',
    description:
      'Request user confirmation to create or extend an API-backed Raynard plugin, or to change how an existing plugin presents its results — for example, adding result cards to specific tools. Use this for semantic requests to build, add, connect, integrate, or extend API access, and for requests to add cards / rendering / visualization to a plugin. This tool never writes code itself.',
    parameters: Type.Object({
      name: Type.String({
        description:
          'Plugin to build or edit. To EDIT an existing plugin, pass its exact installed name/slug (e.g. "dnd-5e-api") so it is edited in place; a non-matching name creates a new empty plugin. Use a fresh short slug (e.g. hacker-news, sec-filings) only when creating a genuinely new plugin.'
      }),
      description: Type.String({
        description:
          'Complete capability the coding agent should implement, including the broader useful API surface rather than only one example query.'
      }),
      sourceUrls: Type.Optional(
        Type.Array(
          Type.String({
            description: 'Official API documentation URL.'
          }),
          {
            description: 'Relevant API documentation URLs supplied by the user or already known.'
          }
        )
      ),
      reason: Type.String({
        description: 'Why installed tools are insufficient and code needs to be written.'
      })
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const buildRequest = {
        name: normalizePluginName(args?.name),
        description: String(args?.description || '').trim(),
        sourceUrls: normalizeSourceUrls(args?.sourceUrls),
        reason: String(args?.reason || '').trim()
      };
      onBuildRequest(buildRequest);
      return {
        content: [
          {
            type: 'text',
            text:
              'A structured plugin build request is ready for user confirmation. Do not provide code in chat.'
          }
        ],
        details: {
          type: 'plugin-build-request',
          ...buildRequest
        },
        terminate: true
      };
    }
  };
}

export function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}
