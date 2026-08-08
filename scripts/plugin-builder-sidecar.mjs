import { createInterface } from 'node:readline';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple } from '@mariozechner/pi-ai';
import { createCodingTools } from '@mariozechner/pi-coding-agent';
import {
  assertBuilderTurnCompleted,
  buildSystemPrompt,
  buildTargetedPluginSnapshot,
  buildUserPrompt,
  validatePluginArtifacts
} from './plugin-builder-core.mjs';

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

function extractAssistantText(message) {
  if (!message || message.role !== 'assistant' || !Array.isArray(message.content)) return '';
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: pluginDir,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderrText = '';
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
      if (code !== 0) {
        reject(new Error(stderrText.trim() || stdout.trim() || `${command} exited with ${code}.`));
        return;
      }
      resolve({ stdout, stderr: stderrText });
    });
    if (options.stdin) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
}

async function validatePluginWorkspace() {
  const files = await readdir(pluginDir);
  const readme = await readFile(`${pluginDir}/README.md`, 'utf8');
  let samplePrompts;
  try {
    const manifest = JSON.parse(await readFile(`${pluginDir}/plugin.json`, 'utf8'));
    samplePrompts = manifest.samplePrompts;
  } catch {
    samplePrompts = undefined;
  }
  const runnerPath = String(request.pluginRunnerPath || '').trim();
  if (!runnerPath) throw new Error('Plugin tool runner path is missing.');
  const listed = await runCommand('node', [runnerPath], {
    stdin: JSON.stringify({ pluginDir, listTools: true })
  });
  const lastLine = listed.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  const payload = JSON.parse(lastLine || '{}');
  if (!payload.ok) throw new Error(payload.error || 'Could not load plugin tools.');
  const validation = validatePluginArtifacts({
    files,
    readme,
    tools: payload.result?.tools,
    samplePrompts,
    requireSamplePrompts: true
  });
  emit({ type: 'status', status: `running_tests:${validation.testFiles.join(',')}` });
  await runCommand('node', ['--test', ...validation.testFiles]);
  emit({
    type: 'status',
    status: `validation_passed:${validation.testFiles.length}_tests:${validation.toolCount}_tools`
  });
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

// Prime an edit turn with the plugin's CURRENT source so the model understands
// the layout up front and does not have to re-read the same files every turn.
// Because we always embed the current files, this doubles as cross-turn memory:
// the state the model sees is authoritative, not something it must reconstruct.
async function readPluginSnapshot(dir) {
  const wanted = ['plugin.json', 'tools.ts', 'client.ts', 'README.md'];
  const parts = [];
  try {
    const entries = await readdir(dir);
    const listing = entries.filter((name) => !name.startsWith('.')).sort().join(', ');
    if (listing) parts.push(`Files in this plugin: ${listing}`);
  } catch {
    // A missing dir is handled elsewhere; just skip the listing.
  }
  for (const name of wanted) {
    try {
      let text = await readFile(`${dir}/${name}`, 'utf8');
      const CAP = 16000;
      if (text.length > CAP) text = `${text.slice(0, CAP)}\n… (${name} truncated; read the file for the rest)`;
      parts.push(`===== ${name} =====\n${text}`);
    } catch {
      // Optional file (e.g. no client.ts / README yet) — skip it.
    }
  }
  return parts.join('\n\n');
}

if (request.editMode) {
  let targetedSnapshot = null;
  if (request.taskKind === 'card-edit' && Array.isArray(request.targetTools) && request.targetTools.length) {
    const files = {};
    try {
      const entries = await readdir(pluginDir);
      const wanted = entries.filter(
        (name) =>
          name === 'tools.ts' ||
          /\.(?:test|spec)\.(?:ts|js|mjs)$/i.test(name)
      );
      await Promise.all(
        wanted.map(async (name) => {
          try {
            files[name] = await readFile(`${pluginDir}/${name}`, 'utf8');
          } catch {
            // A disappearing optional test file should trigger the complete
            // workspace snapshot, not fail the build turn.
          }
        })
      );
      const runnerPath = String(request.pluginRunnerPath || '').trim();
      if (runnerPath) {
        try {
          files['sdk.d.ts'] = await readFile(join(dirname(runnerPath), 'plugin-sdk', 'index.d.ts'), 'utf8');
        } catch {}
      }
      targetedSnapshot = buildTargetedPluginSnapshot({
        files,
        taskKind: request.taskKind,
        targetTools: request.targetTools
      });
    } catch {
      targetedSnapshot = null;
    }
  }
  request.pluginSnapshot = targetedSnapshot || await readPluginSnapshot(pluginDir);
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

process.once('SIGTERM', () => {
  agent.abort();
  setTimeout(() => process.exit(0), 1_000).unref();
});

let finalText = '';
let lastAssistantStopReason = '';
// Track whether the agent actually modified a file this run. A weak/chatty
// coding model can read everything and then end its turn without editing; in
// edit mode we detect that and nudge it once to apply the change.
const FILE_MUTATING_TOOLS = new Set(['edit', 'write', 'copy', 'multiedit', 'create', 'apply_patch']);
const pendingFileMutations = new Set();
let madeFileEdits = false;
const unsubscribe = agent.subscribe((event) => {
  if (event.type === 'message_update') {
    const assistantEvent = event.assistantMessageEvent;
    if (assistantEvent && assistantEvent.type === 'text_delta' && assistantEvent.delta) {
      emit({ type: 'delta', delta: assistantEvent.delta });
    }
    if (assistantEvent && assistantEvent.type === 'thinking_delta' && assistantEvent.delta) {
      emit({ type: 'thinking_delta', delta: assistantEvent.delta });
    }
    if (assistantEvent && assistantEvent.type === 'toolcall_start') {
      emit({ type: 'tool_call', toolName: assistantEvent.toolName || '' });
    }
    return;
  }

  if (event.type === 'tool_execution_start') {
    if (FILE_MUTATING_TOOLS.has(String(event.toolName || '').toLowerCase())) {
      pendingFileMutations.add(String(event.toolCallId || event.toolName || 'mutation'));
    }
    emit({
      type: 'tool_execution_start',
      toolCallId: event.toolCallId || '',
      toolName: event.toolName || '',
      args: event.args || {}
    });
    return;
  }

  if (event.type === 'tool_execution_update') {
    emit({
      type: 'tool_execution_update',
      toolCallId: event.toolCallId || '',
      toolName: event.toolName || '',
      args: event.args || {},
      partialResult: event.partialResult
    });
    return;
  }

  if (event.type === 'tool_execution_end') {
    const mutationKey = String(event.toolCallId || event.toolName || 'mutation');
    if (pendingFileMutations.delete(mutationKey) && !event.isError) {
      madeFileEdits = true;
    }
    emit({
      type: 'tool_execution_end',
      toolCallId: event.toolCallId || '',
      toolName: event.toolName || '',
      result: event.result,
      isError: Boolean(event.isError)
    });
    return;
  }

  if (event.type === 'message_end' && event.message && event.message.role === 'assistant') {
    finalText = extractAssistantText(event.message) || finalText;
    lastAssistantStopReason = String(event.message.stopReason || '');
  }
});

try {
  emit({ type: 'status', status: 'builder_started' });
  await agent.prompt(buildUserPrompt(request));
  if (request.editMode) {
    // An interactive edit turn is one conversational step and is NOT forced
    // through whole-plugin validation. But if the model only inspected files and
    // ended its turn without editing anything (common with weaker coding
    // models), nudge it once to actually apply the change.
    if (!madeFileEdits) {
      emit({ type: 'status', status: 'edit_no_changes_retrying' });
      await agent.prompt(
        'You inspected or planned without writing edits. Stop planning now. Use a filesystem tool immediately to implement the requested change, then run the relevant `node --test` files. Do not describe code that remains unwritten.'
      );
    }
    assertBuilderTurnCompleted({
      editMode: true,
      madeFileEdits,
      stopReason: lastAssistantStopReason
    });
  } else {
    // Fresh builds are gated by a full validate-or-retry pass.
    try {
      await validatePluginWorkspace();
    } catch (validationError) {
      emit({ type: 'status', status: 'validation_failed_retrying' });
      await agent.prompt(
        `The required validation failed:\n${validationError.message}\nFix the plugin, run every node --test test file, and ensure runtime tool discovery succeeds.`
      );
      await validatePluginWorkspace();
    }
    assertBuilderTurnCompleted({
      editMode: false,
      madeFileEdits,
      stopReason: lastAssistantStopReason
    });
  }
  unsubscribe();
  emit({ type: 'done', text: finalText || (request.editMode ? 'Done.' : 'Plugin builder completed.') });
} catch (error) {
  unsubscribe();
  const message = error && error.message ? error.message : String(error);
  stderr.write(`[plugin-builder] ${message}\n`);
  emit({ type: 'error', error: message });
  process.exit(1);
}
