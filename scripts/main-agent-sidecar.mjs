import { createInterface } from 'node:readline';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { spawn } from 'node:child_process';
import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple, Type } from '@mariozechner/pi-ai';
import {
  buildMainAgentSystemPrompt,
  createBuildRequestTool,
  createGeneratedPluginTools,
  createModel,
  extractAssistantText,
  toAgentMessages
} from './main-agent-core.mjs';

function emit(event) {
  output.write(`${JSON.stringify(event)}\n`);
}

function readRequest() {
  return new Promise((resolve, reject) => {
    let body = '';
    const reader = createInterface({ input, terminal: false });
    reader.on('line', (line) => {
      body += line;
    });
    reader.on('close', () => {
      try {
        resolve(JSON.parse(body || '{}'));
      } catch (error) {
        reject(error);
      }
    });
    reader.on('error', reject);
  });
}

const request = await readRequest();
const apiKey = String(request.apiKey || '').trim();
const messages = Array.isArray(request.messages) ? request.messages : [];
const currentMessage = messages.at(-1);

if (!apiKey) {
  emit({ type: 'error', error: 'A model API key is required.' });
  process.exit(1);
}
if (!currentMessage || currentMessage.role !== 'user' || !String(currentMessage.content || '').trim()) {
  emit({ type: 'error', error: 'A current user message is required.' });
  process.exit(1);
}

function executePluginTool(toolRequest, signal) {
  return new Promise((resolve, reject) => {
    const runnerPath = String(request.pluginRunnerPath || '').trim();
    if (!runnerPath) {
      reject(new Error('Plugin tool runner path is missing.'));
      return;
    }
    const child = spawn('node', [runnerPath], {
      cwd: toolRequest.pluginDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderrText = '';
    const abort = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderrText += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new Error('Plugin tool call stopped.'));
        return;
      }
      const lastLine = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);
      if (!lastLine) {
        reject(new Error(stderrText.trim() || `Plugin tool runner exited with ${code}.`));
        return;
      }
      try {
        const payload = JSON.parse(lastLine);
        if (!payload.ok) {
          reject(new Error(payload.error || 'Plugin tool failed.'));
          return;
        }
        resolve(payload.result);
      } catch (error) {
        reject(new Error(`Plugin tool runner returned invalid JSON: ${error.message}`));
      }
    });
    child.stdin.end(
      JSON.stringify({
        pluginDir: toolRequest.pluginDir,
        toolName: toolRequest.toolName,
        args: toolRequest.args
      })
    );
  });
}

const generatedTools = createGeneratedPluginTools({
  Type,
  plugins: request.plugins,
  executePluginTool
});
let buildRequest = null;
const buildRequestTool = createBuildRequestTool(Type, (nextRequest) => {
  buildRequest = nextRequest;
  emit({ type: 'build_request', buildRequest: nextRequest });
});
const tools = [...generatedTools, buildRequestTool];

// Real identities of installed plugins so the agent edits an existing plugin by
// its exact name instead of inventing a near-miss name that scaffolds a
// duplicate empty plugin.
const installedPlugins = (Array.isArray(request.plugins) ? request.plugins : [])
  .map((plugin) => {
    const dir = String(plugin.directory || '');
    const slug =
      dir.split('/').filter(Boolean).pop() ||
      String(plugin.id || '').replace(/^raynard\.generated\./, '');
    return { slug, name: String(plugin.name || slug) };
  })
  .filter((plugin) => plugin.slug);

const agent = new Agent({
  initialState: {
    systemPrompt: buildMainAgentSystemPrompt({
      mode: request.mode === 'build' ? 'build' : 'explore',
      toolNames: generatedTools.map((tool) => tool.name),
      plugins: installedPlugins
    }),
    model: createModel(request),
    thinkingLevel: 'off',
    tools,
    messages: toAgentMessages(messages, request)
  },
  getApiKey: async () => apiKey,
  streamFn: (model, context, options) => streamSimple(model, context, { ...options, apiKey }),
  toolExecution: 'sequential'
});

process.once('SIGTERM', () => {
  agent.abort();
  setTimeout(() => process.exit(0), 1_000).unref();
});

let finalText = '';
const unsubscribe = agent.subscribe((event) => {
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (update?.type === 'text_delta' && update.delta) {
      emit({ type: 'delta', delta: update.delta });
    }
    if (update?.type === 'thinking_delta' && update.delta) {
      emit({ type: 'thinking_delta', delta: update.delta });
    }
    return;
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    finalText = extractAssistantText(event.message) || finalText;
    return;
  }
  if (event.type === 'tool_execution_start') {
    emit({
      type: 'tool_call',
      toolName: event.toolName || '',
      args: event.args || {}
    });
    return;
  }
  if (event.type === 'tool_execution_end') {
    emit({
      type: event.isError ? 'tool_error' : 'tool_result',
      toolName: event.toolName || '',
      args: event.args || {},
      result: event.result?.details ?? event.result ?? null,
      error: event.isError
        ? event.result?.content?.map((block) => block.text || '').join('') || 'Tool failed.'
        : undefined
    });
  }
});

try {
  await agent.prompt(String(currentMessage.content).trim());
  unsubscribe();
  emit({ type: 'done', text: finalText, buildRequest });
} catch (error) {
  unsubscribe();
  const message = error?.message || String(error);
  stderr.write(`[main-agent] ${message}\n`);
  emit({ type: 'error', error: message });
  process.exit(1);
}
