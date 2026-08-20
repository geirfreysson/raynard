import { createInterface } from 'node:readline';
import { stdin as input, stdout as output, stderr } from 'node:process';
import { spawn } from 'node:child_process';
import { Agent } from '@mariozechner/pi-agent-core';
import { streamSimple, Type } from '@mariozechner/pi-ai';
import {
  buildMainAgentSystemPrompt,
  createAvailableExtensionSearchTool,
  defaultThinkingLevel,
  createBuildRequestTool,
  createDirectAnswerTool,
  createExtensionRecommendationTool,
  createGeneratedPluginTools,
  createModel,
  createUsageTotal,
  extractAssistantText,
  runWithTransientResume,
  toAgentMessages
} from './main-agent-core.mjs';

function emit(event) {
  output.write(`${JSON.stringify(event)}\n`);
}

/**
 * Newline-delimited JSON both ways. Unlike the builder sidecar this keeps
 * reading stdin after the request, so a message typed while the agent is
 * working can be steered into the run:
 *
 *   in   {...request...}                           first line, required
 *   in   {"type":"steer","text":"..."}             later, optional
 *   in   {"type":"follow_up","text":"..."}         later, optional
 *   out  {"type":"steering_applied","text":"..."}  a queued message just went in
 *
 * Because stdin stays open the process no longer exits on EOF; the terminal
 * paths below close the reader explicitly.
 */
const reader = createInterface({ input, terminal: false });
let resolveRequest;
const requestPromise = new Promise((resolve) => {
  resolveRequest = resolve;
});
/** Commands that arrived before the Agent existed. Flushed once it does. */
const bufferedCommands = [];
/**
 * Mirror of the texts we have handed to the Agent's queues. The loop emits a
 * plain user `message_start` when it injects one, and the initial prompt looks
 * exactly the same, so matching on this array is what tells them apart.
 */
const queuedTexts = [];
let applyCommand = (command) => {
  bufferedCommands.push(command);
};

reader.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (resolveRequest) {
    const resolve = resolveRequest;
    resolveRequest = null;
    resolve(message);
    return;
  }
  if (message?.type !== 'steer' && message?.type !== 'follow_up') return;
  const text = String(message.text || '').trim();
  if (!text) return;
  applyCommand({ type: message.type, text });
});

/** Stop holding the event loop open once the turn has its terminal event. */
function closeInput() {
  reader.close();
  input.pause();
}

/** Steering messages carry a content array; history entries carry a string. */
function userMessageText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text')
    .map((block) => block.text || '')
    .join('');
}

const request = await requestPromise;
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
    const child = spawn(process.execPath, [runnerPath], {
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
          const failure = new Error(payload.error || 'Plugin tool failed.');
          // Carry a missing-credential signal through the rejection so the
          // tool wrapper can end the turn with a prompt rather than an error.
          if (payload.credentialRequest) failure.credentialRequest = payload.credentialRequest;
          reject(failure);
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
        args: toolRequest.args,
        credentials: toolRequest.credentials || {}
      })
    );
  });
}

let credentialRequest = null;
const generatedTools = createGeneratedPluginTools({
  Type,
  plugins: request.plugins,
  executePluginTool,
  onCredentialRequest: (nextRequest) => {
    credentialRequest = nextRequest;
    // Reuses the generic `result` field so no Rust stream change is needed.
    emit({ type: 'credential_request', result: nextRequest });
  }
});

// Real identities of installed plugins so the agent edits an existing plugin by
// its exact name instead of inventing a near-miss name that scaffolds a
// duplicate empty plugin.
const installedPlugins = (Array.isArray(request.plugins) ? request.plugins : [])
  .map((plugin) => {
    const dir = String(plugin.directory || '');
    const slug =
      dir.split('/').filter(Boolean).pop() ||
      String(plugin.id || '').replace(/^raynard\.generated\./, '');
    return {
      slug,
      name: String(plugin.name || slug),
      // A plugin with no runtime tools is a build that never finished. Keeping
      // the count lets the prompt say so; without it the agent treats the name
      // as taken and invents a suffixed one, orphaning the unfinished work.
      toolCount: Array.isArray(plugin.tools) ? plugin.tools.length : 0
    };
  })
  .filter((plugin) => plugin.slug);

let buildRequest = null;
let directAnswer = null;
let extensionRecommendation = null;
const buildRequestTool = createBuildRequestTool(
  Type,
  (nextRequest) => {
    buildRequest = nextRequest;
    emit({ type: 'build_request', buildRequest: nextRequest });
  },
  { installedPluginNames: installedPlugins.map((plugin) => plugin.slug) }
);
const directAnswerTool = createDirectAnswerTool(Type, (answer) => {
  directAnswer = answer;
});
const availableExtensionSearchTool = createAvailableExtensionSearchTool(
  Type,
  request.availableExtensions
);
const extensionRecommendationTool = createExtensionRecommendationTool(
  Type,
  request.availableExtensions,
  (recommendation) => {
    extensionRecommendation = recommendation;
    emit({ type: 'extension_recommendation', result: recommendation });
  }
);
const tools = [
  ...generatedTools,
  availableExtensionSearchTool,
  extensionRecommendationTool,
  buildRequestTool,
  directAnswerTool
];
const internalToolNames = new Set([
  availableExtensionSearchTool.name,
  extensionRecommendationTool.name,
  directAnswerTool.name
]);

// Built once so its resolved contextWindow — pi's catalog first, FALLBACK_LIMITS
// second — is the same number both the agent runs against and /status divides by.
const agentModel = createModel(request);

const agent = new Agent({
  initialState: {
    systemPrompt: buildMainAgentSystemPrompt({
      mode: request.mode === 'build' ? 'build' : 'explore',
      toolNames: generatedTools.map((tool) => tool.name),
      plugins: installedPlugins
    }),
    model: agentModel,
    thinkingLevel: defaultThinkingLevel('explore'),
    tools,
    messages: toAgentMessages(messages, request)
  },
  getApiKey: async () => apiKey,
  // maxRetries lets the provider SDK absorb a 429 raised before the stream opens
  // without the turn ever noticing. Errors raised once the stream is running are
  // not retryable at that layer; runWithTransientResume below covers those.
  streamFn: (model, context, options) =>
    streamSimple(model, context, { ...options, apiKey, maxRetries: 4, maxRetryDelayMs: 30_000 }),
  toolExecution: 'sequential'
  // steeringMode/followUpMode stay at pi's "one-at-a-time" default: one queued
  // message per turn, so a burst of typing does not land as a single wall of
  // text in the middle of the agent's work.
});

// The queues only exist once the Agent does, so anything typed while the model
// config was still resolving is replayed here.
applyCommand = (command) => {
  const message = {
    role: 'user',
    content: [{ type: 'text', text: command.text }],
    timestamp: Date.now()
  };
  queuedTexts.push(command.text);
  if (command.type === 'follow_up') {
    agent.followUp(message);
  } else {
    agent.steer(message);
  }
};
for (const command of bufferedCommands.splice(0)) applyCommand(command);

process.once('SIGTERM', () => {
  agent.abort();
  setTimeout(() => process.exit(0), 1_000).unref();
});

let finalText = '';
// The agent loop returns normally when a round comes back errored or aborted, so
// without tracking this a failed final round is emitted as a successful turn
// carrying whatever stale text streamed earlier.
let lastStopReason = '';
let lastErrorMessage = '';
// Whether the FINAL assistant message carried text of its own. Without this, a
// run that ends on an empty completion falls back to text streamed several
// rounds earlier — which is how a "let me fetch the data…" preamble came to be
// presented as a finished answer.
let lastMessageHadText = false;
// Every assistant message of this turn is billed, including tool rounds and
// rounds replayed after a transient failure, so usage accumulates and is never
// cleared by resetRound.
const usageTotal = createUsageTotal(agentModel.contextWindow);
// Pi reports contentIndex for semantic text blocks. Preserve that boundary in
// the live stream too, so interrupted/cancelled snapshots cannot glue a fence
// or a word to narration from an earlier tool round.
let streamedTextIndex;
let streamedTextMessage = 0;
let currentTextMessage = 0;
const unsubscribe = agent.subscribe((event) => {
  if (event.type === 'message_start' && event.message?.role === 'user') {
    // A user message inside a running loop is either the turn's own prompt or a
    // message we queued. Only the queued ones are in queuedTexts.
    const text = userMessageText(event.message);
    const index = queuedTexts.indexOf(text);
    if (index !== -1) {
      queuedTexts.splice(index, 1);
      // The host opens a fresh assistant bubble here, so the message-boundary
      // separator below would only pad it with blank lines.
      streamedTextMessage = 0;
      streamedTextIndex = undefined;
      emit({ type: 'steering_applied', text });
    }
    return;
  }
  if (event.type === 'message_start' && event.message?.role === 'assistant') {
    currentTextMessage += 1;
    streamedTextIndex = undefined;
    return;
  }
  if (event.type === 'message_update') {
    const update = event.assistantMessageEvent;
    if (update?.type === 'text_delta' && update.delta) {
      if (
        streamedTextMessage > 0 &&
        (streamedTextMessage !== currentTextMessage || streamedTextIndex !== update.contentIndex)
      ) {
        emit({ type: 'delta', delta: '\n\n' });
      }
      emit({ type: 'delta', delta: update.delta });
      streamedTextMessage = currentTextMessage;
      streamedTextIndex = update.contentIndex;
    }
    if (update?.type === 'thinking_delta' && update.delta) {
      emit({ type: 'thinking_delta', delta: update.delta });
    }
    return;
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    usageTotal.add(event.message.usage);
    const text = extractAssistantText(event.message);
    lastMessageHadText = Boolean(text);
    finalText = text || finalText;
    lastStopReason = String(event.message.stopReason || '');
    lastErrorMessage = String(event.message.errorMessage || '');
    return;
  }
  if (event.type === 'tool_execution_start') {
    if (internalToolNames.has(event.toolName || '')) return;
    emit({
      type: 'tool_call',
      toolName: event.toolName || '',
      args: event.args || {}
    });
    return;
  }
  if (event.type === 'tool_execution_end') {
    if (internalToolNames.has(event.toolName || '')) return;
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
  const { resumeAttempts } = await runWithTransientResume({
    agent,
    start: () => agent.prompt(String(currentMessage.content).trim()),
    readFailure: () => ({ stopReason: lastStopReason, errorMessage: lastErrorMessage }),
    onResume: (event) => {
      stderr.write(`[main-agent] resuming after ${event.reason}: attempt ${event.attempt}\n`);
      emit({ type: 'retry', ...event });
    },
    resetRound: () => {
      lastStopReason = '';
      lastErrorMessage = '';
      lastMessageHadText = false;
    }
  });
  // A build request, a credential prompt, a direct answer, or an extension
  // recommendation ends the turn in a card of its own; continuing past one would
  // answer a question the host has already replaced with something else. The
  // host hands the undelivered text back to the composer instead.
  const endsInACard = Boolean(
    buildRequest || credentialRequest || directAnswer || extensionRecommendation
  );
  // Otherwise a message queued between the loop's last steering poll and
  // agent_end would die with the process. continue() drains both queues itself
  // when the transcript ends on an assistant message.
  while (
    !endsInACard &&
    lastStopReason !== 'error' &&
    lastStopReason !== 'aborted' &&
    agent.hasQueuedMessages()
  ) {
    lastMessageHadText = false;
    await agent.continue();
  }
  unsubscribe();
  // A direct answer, a build request, or a credential request is a legitimate
  // terminal outcome even when the underlying round reports a stop reason.
  // Each of these ends the turn with no assistant text, so without this guard
  // the host would replace the prompt card with an error bubble.
  const failed = lastStopReason === 'error' || lastStopReason === 'aborted';
  if (
    !directAnswer &&
    !buildRequest &&
    !credentialRequest &&
    !extensionRecommendation &&
    (failed || !lastMessageHadText)
  ) {
    const reason =
      lastErrorMessage ||
      (lastStopReason === 'aborted'
        ? 'The model run was aborted.'
        : failed
          ? 'The model run failed before it produced an answer.'
          : 'The model stopped after its tool calls without writing an answer. This usually means the context was exhausted — narrow the query so tools return less data, then try again.');
    // Host stderr is discarded, so the stop reason has to travel in the error
    // string itself to reach the turn log.
    const detail = lastStopReason ? `${reason} (stopReason: ${lastStopReason})` : reason;
    stderr.write(`[main-agent] stopReason=${lastStopReason || 'none'} ${reason}\n`);
    // resumeAttempts lets the host say "retried 3 times" instead of presenting a
    // one-shot failure the user could reasonably expect us to have retried.
    // A turn that burned tokens and then failed still spent them, so usage rides
    // the error too rather than vanishing from the totals.
    emit({
      type: 'error',
      error: detail,
      stopReason: lastStopReason,
      resumeAttempts,
      usage: usageTotal.value()
    });
    process.exit(1);
  }
  emit({
    type: 'done',
    text: directAnswer || extensionRecommendation?.answer || finalText,
    buildRequest,
    result: extensionRecommendation || credentialRequest || undefined,
    stopReason: lastStopReason,
    usage: usageTotal.value()
  });
  closeInput();
} catch (error) {
  unsubscribe();
  const message = error?.message || String(error);
  stderr.write(`[main-agent] ${message}\n`);
  emit({ type: 'error', error: message });
  process.exit(1);
}
