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

export function buildMainAgentSystemPrompt({ mode, toolNames }) {
  const names = Array.isArray(toolNames) && toolNames.length ? toolNames.join(', ') : '(none)';
  const modePolicy =
    mode === 'build'
      ? `You are in Build mode. Decide semantically whether the user is asking to add, create, change, or extend an API-backed capability. For such requests, call request_plugin_build. Do not answer a build request with code, a tutorial, or a proposed file listing. Only the separate Pi coding agent may write plugin files, and it starts only after the user confirms the structured build request.`
      : `You are in Explore mode. Never write code or invoke the coding agent. Use installed tools when they can answer the request. If required API access is missing, do not guess or answer from general knowledge. Do not answer the inaccessible factual question. Call request_plugin_build so the interface can offer Build mode.`;

  return `You are Raynard, a concise research agent with access to API-backed tools.

${modePolicy}

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
          return {
            content: [{ type: 'text', text: formatToolResult(result) }],
            details: result
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
      'Request user confirmation to create or extend an API-backed Raynard plugin when installed tools cannot provide the required capability. Use this for semantic requests to build, add, connect, integrate, or extend API access. This tool never writes code itself.',
    parameters: Type.Object({
      name: Type.String({
        description: 'Short descriptive plugin name, such as hacker-news or sec-filings.'
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
