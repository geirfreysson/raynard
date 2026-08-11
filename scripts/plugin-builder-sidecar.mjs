import { createInterface } from 'node:readline';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { spawn } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Agent } from '@mariozechner/pi-agent-core';
import { completeSimple, streamSimple } from '@mariozechner/pi-ai';
import { createCodingTools } from '@mariozechner/pi-coding-agent';
import { createModel } from './main-agent-core.mjs';
import {
  SUMMARIZATION_SYSTEM_PROMPT,
  createContextCompactor,
  serializeForSummary
} from './builder-compaction.mjs';
import {
  assertBuilderTurnCompleted,
  buildSystemPrompt,
  buildTargetedPluginSnapshot,
  buildUserPrompt,
  hasAuthoredPluginWork,
  bashCommandEscapesRoot,
  resolveInsideRoot,
  validatePluginArtifacts,
  WORKSPACE_ESCAPE_MESSAGE
} from './plugin-builder-core.mjs';

/**
 * Hold Pi's coding tools inside one plugin directory.
 *
 * `createCodingTools(cwd)` sets a working directory but enforces nothing: its
 * path resolver accepts absolute and `~` paths, and bash gets a real shell. The
 * builder used that reach to go read sibling plugins instead of working from
 * its instructions, which is both wrong and a way for one plugin's build to
 * touch another's files.
 */
function confineCodingTools(tools, root) {
  return tools.map((tool) => {
    if (tool.name === 'bash') {
      return {
        ...tool,
        execute: async (toolCallId, params, signal, onUpdate) => {
          if (bashCommandEscapesRoot(params?.command)) {
            throw new Error(WORKSPACE_ESCAPE_MESSAGE);
          }
          return tool.execute(toolCallId, params, signal, onUpdate);
        }
      };
    }
    return {
      ...tool,
      execute: async (toolCallId, params, signal, onUpdate) => {
        const requested = params?.path;
        if (requested !== undefined && !resolveInsideRoot(root, requested)) {
          throw new Error(WORKSPACE_ESCAPE_MESSAGE);
        }
        return tool.execute(toolCallId, params, signal, onUpdate);
      }
    };
  });
}

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
  let auth;
  try {
    const manifest = JSON.parse(await readFile(`${pluginDir}/plugin.json`, 'utf8'));
    samplePrompts = manifest.samplePrompts;
    auth = manifest.auth;
  } catch {
    samplePrompts = undefined;
    auth = undefined;
  }
  // Source text so validation can check that every credential the plugin reads
  // is also declared and documented.
  const sources = await Promise.all(
    files
      .filter((name) => /\.(?:ts|js|mjs)$/i.test(name) && !/\.(?:test|spec)\./i.test(name))
      .map((name) => readFile(`${pluginDir}/${name}`, 'utf8').catch(() => ''))
  );
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
    auth,
    sources,
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
  // Named files first so the important ones survive the budget, then whatever
  // else the author wrote. A resumed build often turns on a supporting module
  // or a test file that this list would never have guessed.
  const preferred = ['plugin.json', 'tools.ts', 'client.ts', 'README.md'];
  const parts = [];
  let entries = [];
  try {
    entries = (await readdir(dir)).filter((name) => !name.startsWith('.'));
    const listing = [...entries].sort().join(', ');
    if (listing) parts.push(`Files in this plugin: ${listing}`);
  } catch {
    // A missing dir is handled elsewhere; just skip the listing.
  }
  const rest = entries
    .filter((name) => !preferred.includes(name))
    .filter((name) => /\.(?:ts|js|mjs|json|md)$/i.test(name))
    .sort();

  const FILE_CAP = 16000;
  const TOTAL_CAP = 120000;
  let used = 0;
  for (const name of [...preferred, ...rest]) {
    if (used >= TOTAL_CAP) {
      parts.push(`… (remaining files omitted for length; read them with a file tool if needed)`);
      break;
    }
    try {
      let text = await readFile(`${dir}/${name}`, 'utf8');
      if (text.length > FILE_CAP) {
        text = `${text.slice(0, FILE_CAP)}\n… (${name} truncated; read the file for the rest)`;
      }
      used += text.length;
      parts.push(`===== ${name} =====\n${text}`);
    } catch {
      // Optional file (e.g. no client.ts / README yet) — skip it.
    }
  }
  return parts.join('\n\n');
}

/** Reads what `hasAuthoredPluginWork` needs to judge the workspace. */
async function hasAuthoredWork(dir) {
  try {
    const files = await readdir(dir);
    const toolsSource = await readFile(`${dir}/tools.ts`, 'utf8').catch(() => '');
    return hasAuthoredPluginWork({ files, toolsSource });
  } catch {
    return false;
  }
}

/**
 * The SDK's declarations, so the prompt can hand over the interface instead of
 * the model going to find it.
 *
 * The declarations are read from the host's own copy beside the tool runner —
 * that one is always present. The path reported to the model is the INSTALLED
 * package, which the host puts in the generated-plugin root's node_modules,
 * one level above this workspace. Looking for it inside the plugin directory
 * is the first thing a builder tries, and it always fails.
 */
async function readSdkSurface(runnerPath, dir) {
  const sourceDir = runnerPath ? join(dirname(runnerPath), 'plugin-sdk') : '';
  const installedDir = dir ? join(dirname(dir), 'node_modules', '@raynard', 'plugin-sdk') : '';
  if (!sourceDir) return { sdkDir: installedDir, sdkTypes: {} };
  const sdkTypes = {};
  await Promise.all(
    ['index.d.ts', 'testing.d.ts'].map(async (name) => {
      try {
        sdkTypes[name] = await readFile(join(sourceDir, name), 'utf8');
      } catch {
        // A missing declaration file just means that part is not described.
      }
    })
  );
  return { sdkDir: installedDir, sdkTypes };
}

const sdkSurface = await readSdkSurface(String(request.pluginRunnerPath || '').trim(), pluginDir);
request.sdkDir = sdkSurface.sdkDir;
request.sdkTypes = sdkSurface.sdkTypes;

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
} else if (await hasAuthoredWork(pluginDir)) {
  // A fresh build over a directory that already holds work is a resume. The
  // snapshot is the only memory that survives between builder processes.
  request.pluginSnapshot = await readPluginSnapshot(pluginDir);
  emit({ type: 'status', status: 'resuming_unfinished_build' });
}

const model = createModel(request);
const systemPrompt = buildSystemPrompt(request);

/**
 * Summarize the dropped prefix with the same model that is doing the build.
 * Returns '' on any failure: losing the summary is survivable, losing the turn
 * to a compaction error is not.
 */
async function summarizeForCompaction(dropped) {
  try {
    const reply = await completeSimple(
      model,
      {
        systemPrompt: SUMMARIZATION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: serializeForSummary(dropped) }]
      },
      { apiKey, maxTokens: 2048 }
    );
    return String(
      (Array.isArray(reply?.content) ? reply.content : [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Keep a long build inside its context window.
 *
 * Pi's own coding agent compacts; a bare Agent does not, so a build that ran
 * long grew its transcript until the provider refused.
 */
const compactContext = createContextCompactor({
  contextWindow: model.contextWindow,
  summarize: summarizeForCompaction,
  onStatus: (status) => emit({ type: 'status', status })
});

const agent = new Agent({
  initialState: {
    systemPrompt,
    model,
    thinkingLevel: 'off',
    tools: confineCodingTools(createCodingTools(pluginDir), pluginDir)
  },
  getApiKey: async () => apiKey,
  streamFn: (streamModel, context, options) =>
    streamSimple(streamModel, context, { ...options, apiKey }),
  transformContext: (messages) => compactContext(messages),
  toolExecution: 'sequential'
});

process.once('SIGTERM', () => {
  agent.abort();
  setTimeout(() => process.exit(0), 1_000).unref();
});

let finalText = '';
let lastAssistantStopReason = '';
// Pi ends its loop silently on a failed stream: the reason lives on the
// assistant message, not in a thrown error. Capture it or the turn dies
// anonymously.
let lastAssistantError = '';
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
    lastAssistantError = String(event.message.errorMessage || '');
    if (lastAssistantError || (lastAssistantStopReason && lastAssistantStopReason !== 'stop')) {
      emit({
        type: 'status',
        status: `stream_ended:${lastAssistantStopReason || 'unknown'}${
          lastAssistantError ? `:${lastAssistantError}` : ''
        }`
      });
    }
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
      stopReason: lastAssistantStopReason,
      errorMessage: lastAssistantError
    });
  } else {
    // Check HOW the turn ended before checking WHAT it produced. A run that hit
    // the output limit or lost its stream also fails validation, and validating
    // first reported that symptom ("no runtime tool") as the cause while the
    // real reason was discarded.
    assertBuilderTurnCompleted({
      editMode: false,
      madeFileEdits,
      stopReason: lastAssistantStopReason,
      errorMessage: lastAssistantError
    });
    // Fresh builds are gated by a full validate-or-retry pass.
    try {
      await validatePluginWorkspace();
    } catch (validationError) {
      emit({ type: 'status', status: 'validation_failed_retrying' });
      await agent.prompt(
        `The required validation failed:\n${validationError.message}\nFix the plugin, run every node --test test file, and ensure runtime tool discovery succeeds.`
      );
      assertBuilderTurnCompleted({
        editMode: false,
        madeFileEdits,
        stopReason: lastAssistantStopReason,
        errorMessage: lastAssistantError
      });
      await validatePluginWorkspace();
    }
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
