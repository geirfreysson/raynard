import { Channel, invoke } from '@tauri-apps/api/core';
import type { BuildRequestAuth } from './build-request-flow';
import { decodeCredentialRequest } from './credential-request-flow';
import type { CredentialRequest as AgentCredentialRequest } from './credential-request-flow';
import {
  decodeExtensionRecommendation,
  type ExtensionRecommendation
} from './extension-recommendation';

export type { AgentCredentialRequest };

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

/**
 * Token counts for one turn, summed across its rounds by the sidecar.
 *
 * `contextTokens` is the last round's prompt plus completion, not the sum: a
 * turn with several tool calls resends the conversation each time, so the sum
 * exceeds the window on a healthy chat and only the last round describes how
 * full the window actually is.
 */
export type TurnUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  rounds?: number;
  contextTokens?: number;
  contextWindow?: number;
};

export type AgentReply = {
  content: string;
  provider?: string;
  model?: string;
  buildRequest?: AgentBuildRequest;
  extensionRecommendation?: ExtensionRecommendation;
  usage?: TurnUsage;
};

export type StreamPayload = {
  stream_id: string;
  event_type:
    | 'delta'
    | 'thinking_delta'
    | 'tool_call'
    | 'tool_result'
    | 'tool_error'
    | 'tool_execution_start'
    | 'tool_execution_update'
    | 'tool_execution_end'
    | 'build_request'
    | 'credential_request'
    | 'extension_recommendation'
    | 'steering_applied'
    | 'done'
    | 'retry'
    | 'status'
    | 'error';
  delta?: string | null;
  text?: string | null;
  error?: string | null;
  /** Sidecar retry/resume metadata, relayed verbatim by Rust. */
  retry?: {
    reason?: string | null;
    attempt?: number | null;
    maxAttempts?: number | null;
    delayMs?: number | null;
    resumeAttempts?: number | null;
  } | null;
  provider?: string | null;
  model?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  args?: Record<string, unknown> | null;
  partial_result?: unknown;
  result?: unknown;
  is_error?: boolean | null;
  build_request?: AgentBuildRequest | null;
  /** Present on `done`; the turn's summed token counts. */
  usage?: TurnUsage | null;
};

export type AgentBuildRequest = {
  name: string;
  description: string;
  sourceUrls: string[];
  reason: string;
  /** Advance notice that this API needs a key, so the user can register while the build runs. */
  auth?: BuildRequestAuth;
  taskKind?: 'card-edit' | 'plugin-edit' | 'plugin-create';
  targetTools?: string[];
};

export type AgentToolEvent = {
  toolName: string;
  args: Record<string, unknown>;
};

export type AgentToolResultEvent = AgentToolEvent & {
  result: unknown;
};

export type AgentToolExecutionStartEvent = AgentToolEvent & {
  toolCallId: string;
};

export type AgentToolExecutionUpdateEvent = AgentToolExecutionStartEvent & {
  partialResult: unknown;
};

export type AgentToolExecutionEndEvent = {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError: boolean;
};

/** One resume attempt after the provider failed for a reason a retry can fix. */
export type AgentRetryEvent = {
  reason: string;
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  error: string;
};

/**
 * The turn's final failure.
 *
 * `provider`/`model` come from Rust, which stamps them on the stream event
 * before the command itself rejects with a bare string — without this handler
 * the renderer cannot tell the user whose failure it was.
 */
export type AgentErrorEvent = {
  error: string;
  provider?: string;
  model?: string;
  /** How many transient resumes the sidecar spent before giving up. */
  resumeAttempts: number;
};

export type AgentStreamHandlers = {
  onDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onStreamId?: (streamId: string) => void;
  onToolCall?: (event: AgentToolEvent) => void;
  onToolResult?: (event: AgentToolResultEvent) => void;
  onToolError?: (event: AgentToolResultEvent & { error: string }) => void;
  onToolExecutionStart?: (event: AgentToolExecutionStartEvent) => void;
  onToolExecutionUpdate?: (event: AgentToolExecutionUpdateEvent) => void;
  onToolExecutionEnd?: (event: AgentToolExecutionEndEvent) => void;
  onBuildRequest?: (request: AgentBuildRequest) => void;
  onCredentialRequest?: (request: AgentCredentialRequest) => void;
  onExtensionRecommendation?: (recommendation: ExtensionRecommendation) => void;
  /**
   * A message the user typed mid-run has just been injected into the agent's
   * transcript. The answer so far is final; everything after it is a new
   * assistant message.
   */
  onSteeringApplied?: (text: string) => void;
  /** A host-side build milestone (running tests, validation passed). */
  onStatus?: (status: string) => void;
  onRetry?: (event: AgentRetryEvent) => void;
  onError?: (event: AgentErrorEvent) => void;
};

export type PluginBuilderRequest = {
  pluginDir: string;
  name: string;
  description: string;
  sourceUrls: string[];
  prompt: string;
  taskKind?: 'card-edit' | 'plugin-edit' | 'plugin-create';
  targetTools?: string[];
  /** True for an interactive edit of an existing plugin (vs. a fresh build). */
  editMode?: boolean;
  /** Prior build-conversation turns replayed for follow-up continuity. */
  messages?: ChatMessage[];
  /**
   * The credential the main agent already identified for this API, forwarded so
   * the coding agent does not research a sign-up page the host already has.
   */
  auth?: BuildRequestAuth;
};

export async function runMainAgentStream(
  messages: ChatMessage[],
  mode: 'explore' | 'build',
  handlers: AgentStreamHandlers = {},
  chatId?: string
): Promise<AgentReply> {
  const streamId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `agent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  handlers.onStreamId?.(streamId);

  let streamed = '';
  let provider: string | undefined;
  let model: string | undefined;
  let buildRequest: AgentBuildRequest | undefined;

  const onEvent = new Channel<StreamPayload>((payload) => {
    const nextState = applyStreamPayload(payload, streamId, { streamed, provider, model }, handlers);
    streamed = nextState.streamed;
    provider = nextState.provider;
    model = nextState.model;
    if (payload.stream_id === streamId && payload.event_type === 'build_request' && payload.build_request) {
      buildRequest = payload.build_request;
    }
  });

  const reply = await invoke<AgentReply & { result?: unknown }>('run_main_agent_stream', {
    streamId,
    onEvent,
    messages,
    mode,
    chatId
  });

  return {
    content: reply.content || streamed,
    provider: reply.provider ?? provider,
    model: reply.model ?? model,
    buildRequest: reply.buildRequest ?? buildRequest,
    extensionRecommendation: decodeExtensionRecommendation(reply.result) ?? undefined,
    usage: reply.usage
  };
}

/**
 * When a message typed mid-run reaches the agent.
 *
 * `steer` is injected at the next tool-round boundary, so the agent can change
 * course inside the turn it is already running. `followUp` waits until the
 * agent would otherwise stop.
 */
export type SteerDelivery = 'steer' | 'followUp';

/** Rejects when the turn finished between typing and sending. */
export async function steerAgentTurn(
  streamId: string,
  text: string,
  delivery: SteerDelivery = 'steer'
): Promise<void> {
  const normalized = streamId.trim();
  const message = text.trim();
  if (!normalized || !message) return;
  await invoke('steer_main_agent_stream', {
    streamId: normalized,
    text: message,
    delivery: delivery === 'followUp' ? 'follow_up' : 'steer'
  });
}

export async function cancelAgentTurnStream(streamId: string): Promise<void> {
  const normalized = streamId.trim();
  if (!normalized) return;
  await invoke('cancel_model_chat_stream', { streamId: normalized });
}

export async function runPluginBuilderStream(
  request: PluginBuilderRequest,
  handlers: AgentStreamHandlers = {}
): Promise<AgentReply> {
  const streamId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `builder-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  handlers.onStreamId?.(streamId);

  let streamed = '';
  let provider: string | undefined;
  let model: string | undefined;

  const onEvent = new Channel<StreamPayload>((payload) => {
    const nextState = applyStreamPayload(payload, streamId, { streamed, provider, model }, handlers);
    streamed = nextState.streamed;
    provider = nextState.provider;
    model = nextState.model;
  });

  const reply = await invoke<AgentReply>('run_plugin_builder_stream', {
    streamId,
    onEvent,
    request
  });

  return {
    content: reply.content || streamed,
    provider: reply.provider ?? provider,
    model: reply.model ?? model
  };
}

export function applyStreamPayload(
  payload: StreamPayload,
  streamId: string,
  state: { streamed: string; provider?: string; model?: string },
  handlers: AgentStreamHandlers = {}
) {
  if (!payload || payload.stream_id !== streamId) return state;

  const nextState = {
    streamed: state.streamed,
    provider: payload.provider ?? state.provider,
    model: payload.model ?? state.model
  };

  if (payload.event_type === 'delta' && payload.delta) {
    nextState.streamed += payload.delta;
    handlers.onDelta?.(payload.delta);
  }

  if (payload.event_type === 'thinking_delta' && payload.delta) {
    handlers.onThinkingDelta?.(payload.delta);
  }

  const toolName = payload.tool_name?.trim() || '';
  const args = payload.args && typeof payload.args === 'object' ? payload.args : {};
  if (payload.event_type === 'tool_call' && toolName) {
    handlers.onToolCall?.({ toolName, args });
  }
  if (payload.event_type === 'tool_result' && toolName) {
    handlers.onToolResult?.({ toolName, args, result: payload.result });
  }
  if (payload.event_type === 'tool_error' && toolName) {
    handlers.onToolError?.({
      toolName,
      args,
      result: payload.result,
      error: payload.error || `Tool failed: ${toolName}`
    });
  }
  const toolCallId = payload.tool_call_id?.trim() || '';
  if (payload.event_type === 'tool_execution_start' && toolCallId && toolName) {
    handlers.onToolExecutionStart?.({ toolCallId, toolName, args });
  }
  if (payload.event_type === 'tool_execution_update' && toolCallId && toolName) {
    handlers.onToolExecutionUpdate?.({
      toolCallId,
      toolName,
      args,
      partialResult: payload.partial_result
    });
  }
  if (payload.event_type === 'tool_execution_end' && toolCallId && toolName) {
    handlers.onToolExecutionEnd?.({
      toolCallId,
      toolName,
      result: payload.result,
      isError: payload.is_error === true
    });
  }
  if (payload.event_type === 'build_request' && payload.build_request) {
    handlers.onBuildRequest?.(payload.build_request);
  }
  if (payload.event_type === 'status') {
    const status = payload.text?.trim() || '';
    if (status) handlers.onStatus?.(status);
  }
  if (payload.event_type === 'retry') {
    handlers.onRetry?.({
      reason: payload.retry?.reason?.trim() || 'unavailable',
      attempt: Number(payload.retry?.attempt) || 1,
      maxAttempts: Number(payload.retry?.maxAttempts) || 1,
      delayMs: Number(payload.retry?.delayMs) || 0,
      error: payload.error || payload.retry?.reason || ''
    });
  }
  if (payload.event_type === 'error') {
    handlers.onError?.({
      error: payload.error || '',
      provider: payload.provider ?? undefined,
      model: payload.model ?? undefined,
      resumeAttempts: Number(payload.retry?.resumeAttempts) || 0
    });
  }
  if (payload.event_type === 'credential_request') {
    // Travels in the generic `result` field, so the Rust forwarder needed no
    // new named column.
    const request = decodeCredentialRequest(payload.result);
    if (request) handlers.onCredentialRequest?.(request);
  }
  if (payload.event_type === 'extension_recommendation') {
    const recommendation = decodeExtensionRecommendation(payload.result);
    if (recommendation) handlers.onExtensionRecommendation?.(recommendation);
  }
  if (payload.event_type === 'steering_applied') {
    const steered = payload.text?.trim() || '';
    if (steered) handlers.onSteeringApplied?.(steered);
  }

  return nextState;
}

export async function loadPiRuntime() {
  const agentCorePackage = '@mariozechner/pi-agent-core';
  const aiPackage = '@mariozechner/pi-ai';
  const [{ Agent }, { getModel }] = await Promise.all([
    import(/* @vite-ignore */ agentCorePackage),
    import(/* @vite-ignore */ aiPackage)
  ]);

  return { Agent, getModel };
}
