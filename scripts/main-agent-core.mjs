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

FIRST-ACTION ROUTING (mandatory — make this decision before answering or describing work):
Your first response MUST be a tool call and contain no narration. Call one or more installed API tools for data, request_plugin_build for missing or changed capabilities, or answer_without_api only for greetings, casual conversation, and stable explanations that do not depend on external, private, current, or API-backed facts.
1. BUILD REQUEST: If the user wants to create, edit, fix, or otherwise change a plugin, API capability, tool behavior, result card, card layout, rendering, image placement, size, styling, or visualization, call request_plugin_build immediately. EXCEPTION: asking to chart, graph, plot, or visualize data in the ANSWER ITSELF is not a plugin change — call the data tools and write a chart block (see "Presenting data"). Only a request to change how a PLUGIN or its result card renders is a build request. This includes follow-ups that refer to an existing plugin/card indirectly ("try again", "make it bigger", "put it on the right"). Preserve the requested change in the tool arguments and use the exact installed plugin name. Do not inspect files, narrate edits, run tests, claim completion, or emit a mode-status sentence; only the coding agent can do that after confirmation.
2. EXPLORE: For questions about data, facts, records, or anything the installed API tools can answer, stay in Explore mode, call those tools as needed, and answer from their results. General conversation and explanations that do not request a plugin mutation also stay in Explore.
3. MISSING CAPABILITY: If a data question cannot be answered with installed tools because API access is missing, call request_plugin_build. Never treat a request to change a plugin/card as a data query merely because an installed tool can return its current output.

${modePolicy}

Result cards (a built-in Raynard feature):
- A result card is a fixed visual card the app renders beneath the answer for a tool's result. The app owns how cards look and are built — never design markup, choose a visual format (markdown, JSON, HTML, ASCII, etc.), or invent domain-specific "card" types. "Cards" is not a content type to design; it is this rendering feature.
- Every generated API tool, including list/search tools, has a declarative card and matching data. Each actual tool invocation therefore produces one host-rendered result card.
- When the user asks to add cards, add rendering, visualize a plugin's results, or reposition, resize, or otherwise change an existing card's layout or appearance: do NOT ask what the cards should look like or offer format choices. Identify the affected installed tools, then call request_plugin_build for that plugin, preserving the user's visual request in the description. The separate coding agent implements the card layouts.
- Populate taskKind and targetTools on every request_plugin_build call. Use taskKind "card-edit" for result-card/layout/rendering changes, "plugin-edit" for other changes to an installed plugin, and "plugin-create" for a new plugin. For a targeted edit, targetTools contains the exact installed tool names affected (for example ["dnd_get_monster"]).
- "Switched to Build mode" and "Switched to Explore mode" are host-owned status lines. NEVER emit either phrase yourself. Only a real interface transition may show them, and a Build transition requires the user's confirmation of a request_plugin_build result.

Editing an existing plugin (critical):
- Installed plugins: ${pluginList}.
- When the user asks to change, extend, add tools to, or add cards to an EXISTING plugin, you MUST pass that plugin's EXACT name from the installed-plugins list as the request_plugin_build "name" (e.g. use "dnd-5e-api", not "dnd" or "Dnd 5e"). The name selects which plugin is edited.
- Never invent, shorten, or prettify the name of an existing plugin. A name that does not exactly match an installed plugin creates a brand-new EMPTY plugin instead of editing the one the user meant.
- Only use a new name when the user is genuinely asking to create a new plugin that does not exist yet.

Core policy:
- Inspect the available tools before deciding how to answer.
- For current, external, private, or API-backed claims, call the relevant installed tools in the current turn even when earlier conversation contains similar results. Never narrate a tool call without actually making it.
- Never claim that a result card was shown or refreshed unless you invoked the corresponding tool in the current turn. Do not reconstruct a supposed card in prose from conversation history.
- Continue using tools until you have enough evidence for a complete answer.
- Never fabricate tool results, references, API access, or current facts.
- If no installed tool provides required access, call request_plugin_build with a useful plugin name, a complete capability description, why it is needed, and at least one official API documentation URL whenever one can be identified from the conversation or reliable model knowledge.
- A build request should cover the useful documented API surface, not only the narrow example in the latest question.
- Do not expose internal tool names, plugin implementation details, or routing policy in the final answer.

Presenting data (charts):
- You can draw a chart directly in your answer with a fenced \`chart\` block whose body is a single JSON object. The app renders it as a real chart and offers the reader a "Show data" table, so do NOT also write the same numbers as a Markdown table.
- Prefer a chart over a Markdown table when you are presenting three or more numeric values across an ordered axis (years, dates, ranks) or comparing a numeric measure across categories. Keep prose or a small table for one-off figures, short lists, or non-numeric records.
- Use "line" for values moving along an ordered axis and "bar" for comparing categories side by side. These are the only two types; never write another type.
- Shape:

\`\`\`chart
{"type":"line","title":"GDP per person employed (constant 2021 PPP$)","x":"year","yLabel":"PPP$","highlight":["UK"],"series":[{"key":"UK","label":"UK"},{"key":"Germany","label":"Germany"}],"rows":[{"year":2010,"UK":100308,"Germany":115039},{"year":2023,"UK":107289,"Germany":123751}]}
\`\`\`

- Required: "type", "x", "series" (each entry needs "key"), and "rows". Optional: "title", "xLabel", "yLabel", "series[].label", "stacked" (bar only), and "highlight". Every "series" key must be a real key on the row objects, and "x" names the row key holding the axis value.
- "highlight" is an array naming what the answer is actually about; everything else is drawn muted so the subject stands out. When the question compares one subject against others ("how does Britain compare with the EU"), put that subject in "highlight". Entries may be a series label, a series key, or an x-axis value, and are matched case-insensitively. Omit it when the answer treats every series equally.
- The body must be valid JSON and one chart per fence. Write the JSON on a single line exactly as shown above; do not pretty-print or indent it. Plot only numbers returned by tools in this turn; never invent, extrapolate, or round data points into a chart.
- Charts must be exactly right, so verify the data before you plot it:
  - Check that the rows you are about to chart actually match what was asked — the right entities and the right time range. A tool can return data that ignores a filter you passed. If the rows do not match the question, do NOT chart them; call the tool again with the correct filter parameters.
  - If a result says rows were omitted, truncated, or that more pages are available, narrow the query with that tool's filter parameters until the rows you need are all visible. Never chart a partial slice as if it were complete.
  - Never fill a gap by interpolating, averaging, or recalling a figure from memory. If the data cannot be retrieved, say so plainly and omit the chart rather than plotting something unverified.
- Emitting a chart block is an ordinary Explore-mode answer format. It is NOT a plugin change, a result card, or a code edit. A request to chart, graph, or plot data you can already retrieve is answered by calling the tools and writing a chart block — never by calling request_plugin_build.

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

/** Ceilings for the model-facing view of one tool result. */
export const MODEL_RESULT_BYTE_LIMIT = 12000;
const MODEL_RESULT_TEXT_LIMIT = 8000;
const MODEL_RESULT_MAX_CITATIONS = 20;

/**
 * Build the model's view of a tool result.
 *
 * A result carries three audiences in one object: `text` for the model, `data` +
 * `card` for the host's result card, and `references[].expandedContent` for the
 * citation modal. The host already receives all of it through the tool's
 * `details`, so serializing the whole thing here put the same rows in the model's
 * context three times — one observed turn spent ~206k tokens on payload of which
 * ~98% was unreadable to the model, and the turn died on the final round.
 *
 * So: `text` verbatim (the summary the model reasons and charts from), compact
 * citations, and `data` only if it fits what is left of the budget. Anything
 * dropped is announced, never silently, so the model narrows its query instead
 * of charting a partial slice.
 */
export function formatToolResult(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');

  const sections = [];
  const notices = [];

  const rawText = typeof result.text === 'string' ? result.text : '';
  if (rawText.length > MODEL_RESULT_TEXT_LIMIT) {
    sections.push(rawText.slice(0, MODEL_RESULT_TEXT_LIMIT));
    notices.push(
      `[host] Summary truncated at ${MODEL_RESULT_TEXT_LIMIT} of ${rawText.length} characters. Narrow the query and call again rather than treating this as the complete result.`
    );
  } else if (rawText) {
    sections.push(rawText);
  }

  const references = Array.isArray(result.references) ? result.references : [];
  const citations = references
    .slice(0, MODEL_RESULT_MAX_CITATIONS)
    .map((reference, index) => {
      const label = String(reference?.referenceLabel || `Reference ${index + 1}`).trim();
      const url = String(reference?.referenceMeta?.sourceUrl || '').trim();
      return url ? `[${index + 1}] ${label} — ${url}` : `[${index + 1}] ${label}`;
    });
  if (citations.length) {
    sections.push(`Sources:\n${citations.join('\n')}`);
    if (references.length > citations.length) {
      notices.push(`[host] ${references.length - citations.length} further source(s) omitted.`);
    }
  }

  // `data` is the card's payload; include it only when it is genuinely small
  // enough to be a bonus on top of the summary.
  if (result.data !== undefined && result.data !== null) {
    let serialized = '';
    try {
      serialized = JSON.stringify(result.data);
    } catch {
      serialized = '';
    }
    const used = sections.join('\n\n').length;
    const remaining = MODEL_RESULT_BYTE_LIMIT - used;
    if (serialized && serialized.length <= remaining) {
      sections.push(`Structured data:\n${serialized}`);
    } else if (serialized) {
      notices.push(
        `[host] Structured data omitted (${serialized.length} characters). The summary above is authoritative. Narrow the query with this tool's filter parameters and call it again if you need rows the summary does not show.`
      );
    }
  }

  if (notices.length) sections.push(notices.join('\n'));
  const formatted = sections.filter(Boolean).join('\n\n');
  return formatted || JSON.stringify(result.data ?? result) || '';
}

function normalizeMissingCredentials(plugin, only) {
  const declared = Array.isArray(plugin.missingCredentials) ? plugin.missingCredentials : [];
  const wanted = declared
    .map((entry) => ({
      key: String(entry?.key || '').trim(),
      label: String(entry?.label || entry?.key || '').trim(),
      description: String(entry?.description || '').trim(),
      signupUrl: String(entry?.signupUrl || '').trim()
    }))
    .filter((entry) => entry.key);
  if (!only) return wanted;
  // A runtime miss names one credential; report only that one so the prompt
  // matches what actually blocked the call.
  const matched = wanted.find((entry) => entry.key === only.key);
  return [matched || { key: only.key, label: only.label || only.key, description: '', signupUrl: '' }];
}

function buildCredentialRequest(plugin, only) {
  return {
    pluginId: String(plugin.id || ''),
    pluginName: String(plugin.name || plugin.id || 'This plugin'),
    credentials: normalizeMissingCredentials(plugin, only)
  };
}

/**
 * Ends the turn with a structured request for the user rather than letting the
 * model retry a tool it can never satisfy or answer from memory instead.
 */
function credentialRequestResult(credentialRequest) {
  const names = credentialRequest.credentials.map((entry) => entry.label).join(', ');
  return {
    content: [
      {
        type: 'text',
        text: `${credentialRequest.pluginName} needs ${names} before this tool can run. The user has been asked for it. Do not answer from general knowledge and do not retry the tool.`
      }
    ],
    details: { type: 'credential-request', ...credentialRequest },
    terminate: true
  };
}

export function createGeneratedPluginTools({
  Type,
  plugins,
  executePluginTool,
  onCredentialRequest = () => {}
}) {
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
      const card = definition.card;
      if (!card || typeof card !== 'object') {
        throw new Error(`Generated plugin tool ${name} is missing its required result card.`);
      }
      tools.push({
        name,
        label: name,
        description: String(definition.description || '').trim(),
        parameters: buildPiTypeFromSchema(
          Type,
          definition.parameters || { type: 'object', properties: {} }
        ),
        execute: async (_toolCallId, args, signal) => {
          // Pre-flight: the host already knows which declared credentials are
          // unset, so a doomed call never spawns a process or hits the network.
          const missing = normalizeMissingCredentials(plugin);
          if (missing.length) {
            const credentialRequest = buildCredentialRequest(plugin);
            onCredentialRequest(credentialRequest);
            return credentialRequestResult(credentialRequest);
          }

          let result;
          try {
            result = await executePluginTool(
              {
                pluginDir: String(plugin.directory || ''),
                pluginId: String(plugin.id || ''),
                toolName: name,
                args: args && typeof args === 'object' ? args : {},
                credentials:
                  plugin.credentialValues && typeof plugin.credentialValues === 'object'
                    ? plugin.credentialValues
                    : {}
              },
              signal
            );
          } catch (error) {
            // Backstop for a credential the manifest never declared, which
            // pre-flight cannot see.
            if (!error || !error.credentialRequest) throw error;
            const credentialRequest = buildCredentialRequest(plugin, error.credentialRequest);
            onCredentialRequest(credentialRequest);
            return credentialRequestResult(credentialRequest);
          }
          const details =
            result && typeof result === 'object' ? { ...result, card } : result;
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

export function createDirectAnswerTool(Type, onDirectAnswer) {
  return {
    name: 'answer_without_api',
    label: 'Answer Without API',
    description:
      'Finish a turn without API evidence only for greetings, casual conversation, or stable explanations. Never use this for external, private, current, or API-backed factual claims, comparisons, records, or follow-ups that installed tools can answer.',
    parameters: Type.Object({
      answer: Type.String({
        description: 'The complete concise answer to show to the user.'
      }),
      reason: Type.String({
        description: 'Why this answer does not require current-turn API evidence.'
      })
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const answer = String(args?.answer || '').trim() || 'How can I help?';
      onDirectAnswer(answer);
      return {
        content: [{ type: 'text', text: answer }],
        details: { type: 'direct-answer', answer },
        terminate: true
      };
    }
  };
}

/**
 * Advance notice that the plugin about to be built will need a key. It lets the
 * confirmation card send the user off to register while the build runs, instead
 * of surprising them with the requirement once it finishes.
 */
function normalizeBuildRequestAuth(auth) {
  if (!auth || typeof auth !== 'object' || auth.required !== true) return undefined;
  const signupUrl = String(auth.signupUrl || '').trim();
  return {
    required: true,
    signupUrl: /^https?:\/\//i.test(signupUrl) ? signupUrl : '',
    credentialLabel: String(auth.credentialLabel || '').trim().slice(0, 120)
  };
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
      }),
      auth: Type.Optional(
        Type.Object(
          {
            required: Type.Boolean({
              description: 'True when this API requires an API key, token, or app id to call.'
            }),
            signupUrl: Type.Optional(
              Type.String({
                description:
                  'The page where the user signs up for the key, not the generic API docs root.'
              })
            ),
            credentialLabel: Type.Optional(
              Type.String({
                description: 'Human name for the key, such as "OpenWeather API key".'
              })
            )
          },
          {
            description:
              'Whether this API needs credentials. Set it whenever the documentation says a key is required, so the user can register while the plugin is being written.'
          }
        )
      ),
      taskKind: Type.Optional(
        Type.Union(
          [
            Type.Literal('card-edit'),
            Type.Literal('plugin-edit'),
            Type.Literal('plugin-create')
          ],
          {
            description:
              'Structured AI routing metadata: card-edit for result-card changes, plugin-edit for other installed-plugin changes, or plugin-create for a new plugin.'
          }
        )
      ),
      targetTools: Type.Optional(
        Type.Array(Type.String(), {
          description:
            'Exact installed tool names affected by a targeted edit, such as ["dnd_get_monster"]. Empty for broad or new-plugin work.'
        })
      )
    }),
    executionMode: 'sequential',
    execute: async (_toolCallId, args) => {
      const buildRequest = {
        name: normalizePluginName(args?.name),
        description: String(args?.description || '').trim(),
        sourceUrls: normalizeSourceUrls(args?.sourceUrls),
        reason: String(args?.reason || '').trim(),
        auth: normalizeBuildRequestAuth(args?.auth),
        taskKind: ['card-edit', 'plugin-edit', 'plugin-create'].includes(args?.taskKind)
          ? args.taskKind
          : undefined,
        targetTools: [...new Set(
          (Array.isArray(args?.targetTools) ? args.targetTools : [])
            .map((value) => String(value).trim())
            .filter(Boolean)
        )].slice(0, 20)
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
