import { createInterface } from 'node:readline';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import { createCodingTools } from '@mariozechner/pi-coding-agent';

function emit(event) {
  output.write(`${JSON.stringify(event)}\n`);
}

function readRequest() {
  return new Promise((resolve, reject) => {
    let body = '';
    input.setEncoding('utf8');
    input.on('data', (chunk) => {
      body += chunk;
    });
    input.on('end', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    input.on('error', reject);
  });
}

function modelApi(provider) {
  if (provider === 'claude') return 'anthropic-messages';
  if (provider === 'openai') return 'openai-responses';
  return 'openai-completions';
}

function modelProvider(provider) {
  if (provider === 'claude') return 'anthropic';
  return provider || 'custom-openai-compatible';
}

function createModel(request) {
  const provider = String(request.provider || '').trim();
  const model = String(request.model || '').trim();
  const baseUrl = String(request.baseUrl || '').trim();
  return {
    id: model,
    name: `${provider || 'custom'} ${model}`,
    api: modelApi(provider),
    provider: modelProvider(provider),
    baseUrl,
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

function buildSystemPrompt(request) {
  const sourceUrls = Array.isArray(request.sourceUrls)
    ? request.sourceUrls.map((url) => String(url).trim()).filter(Boolean)
    : [];
  const sourceBlock = sourceUrls.length ? sourceUrls.map((url) => `- ${url}`).join('\n') : '- none provided';

  return `You are the Raynard plugin builder running in Build mode.

You may write code only inside the current plugin workspace.

Your job is to implement TypeScript API tooling for Raynard Explore mode.

Hard constraints:
- Do not build React components.
- Do not create pages, routes, CSS, visual explorers, or standalone UI.
- Do not modify the host app.
- Do not store API keys or secrets in source.
- Work test-first: create or update tests that fail for the missing API behavior before writing the fetcher implementation.
- Tests must include mocked fetch coverage for every public API fetch helper and every plugin tool.
- Tests for story-list tools must assert non-empty mocked story IDs and rendered story text.
- Do not rely only on skipped network tests or structure-only tests.
- After implementation, run the tests and fix failures before reporting completion.
- Implement API/client/tool code that fetches data and returns structured, citeable references.
- Use the existing plugin scaffold and reference helper.
- Every API-derived result must expose enough raw payload and source metadata for the explorer agent to quote or cite it.
- Prefer small, focused tools over one broad generic tool.
- Every exported tool definition must include a routing-quality description and a JSON parameter schema. Descriptions must say what user questions the tool answers, what API data it fetches, and any important limits or follow-up tools.
- Tool descriptions are injected into the Explore-mode prompt so the agent can pick between generated plugins. Do not use vague descriptions like "fetch data"; make each description specific and distinct.
- Parameter schemas must include property descriptions, required fields, enum values where applicable, and sensible optional fields such as limit, query, symbol, id, date range, or type.
- Update README.md with the implemented tools and source docs used.
- If tests are practical without credentials, add a small smoke test or fixture.

Source documentation:
${sourceBlock}`;
}

function buildUserPrompt(request) {
  return `Implement this Raynard Explore-mode API plugin.

User request:
${String(request.prompt || request.description || '').trim()}

Plugin workspace:
${String(request.pluginDir || '').trim()}

Expected output:
- TypeScript plugin code in index.ts.
- API fetch helpers as needed.
- Tool definitions for the API explorer, each with a specific description and JSON parameter schema that Explore mode can inject into its prompt.
- Reference-producing results using createApiReference().
- No UI code.`;
}

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

const request = await readRequest();
const pluginDir = String(request.pluginDir || '').trim();
const apiKey = String(request.apiKey || '').trim();
if (!pluginDir) {
  emit({ type: 'error', error: 'pluginDir is required.' });
  process.exit(1);
}
if (!apiKey) {
  emit({ type: 'error', error: 'A model API key is required for Build mode.' });
  process.exit(1);
}

const agent = new Agent({
  initialState: {
    systemPrompt: buildSystemPrompt(request),
    model: createModel(request),
    thinkingLevel: 'off',
    tools: createCodingTools(pluginDir)
  },
  getApiKey: async () => apiKey,
  streamFn: (model, context, options) => streamSimple(model, context, { ...options, apiKey }),
  toolExecution: 'sequential'
});

process.on('SIGTERM', () => {
  agent.abort();
});

let finalText = '';
const unsubscribe = agent.subscribe((event) => {
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent && assistantEvent.type === 'text_delta' && assistantEvent.delta) {
      emit({ type: 'delta', delta: assistantEvent.delta });
    }
    if (assistantEvent && assistantEvent.type === 'toolcall_start') {
      emit({ type: 'tool_call', toolName: assistantEvent.toolName || '' });
    }
    return;
  }

  if (event.type === 'tool_execution_start') {
    emit({ type: 'tool_execution_start', toolName: event.toolName || '' });
    return;
  }

  if (event.type === 'tool_execution_end') {
    emit({ type: 'tool_execution_end', toolName: event.toolName || '', isError: Boolean(event.isError) });
    return;
  }

  if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
    finalText = extractAssistantText(event.message) || finalText;
  }
});

try {
  emit({ type: 'status', status: 'builder_started' });
  await agent.prompt(buildUserPrompt(request));
  unsubscribe();
  emit({ type: 'done', text: finalText || 'Plugin builder completed.' });
} catch (error) {
  unsubscribe();
  const message = error && error.message ? error.message : String(error);
  stderr.write(`[plugin-builder] ${message}\n`);
  emit({ type: 'error', error: message });
  process.exit(1);
}
