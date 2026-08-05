import { Channel, invoke } from '@tauri-apps/api/core';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AgentReply = {
  content: string;
  provider?: string;
  model?: string;
  buildRequest?: AgentBuildRequest;
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
    | 'done'
    | 'error';
  delta?: string | null;
  text?: string | null;
  error?: string | null;
  provider?: string | null;
  model?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  args?: Record<string, unknown> | null;
  partial_result?: unknown;
  result?: unknown;
  is_error?: boolean | null;
  build_request?: AgentBuildRequest | null;
};

export type AgentBuildRequest = {
  name: string;
  description: string;
  sourceUrls: string[];
  reason: string;
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
};

export type PluginBuilderRequest = {
  pluginDir: string;
  name: string;
  description: string;
  sourceUrls: string[];
  prompt: string;
  /** True for an interactive edit of an existing plugin (vs. a fresh build). */
  editMode?: boolean;
  /** Prior build-conversation turns replayed for follow-up continuity. */
  messages?: ChatMessage[];
};

export async function runMainAgentStream(
  messages: ChatMessage[],
  mode: 'explore' | 'build',
  handlers: AgentStreamHandlers = {}
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

  const reply = await invoke<AgentReply>('run_main_agent_stream', {
    streamId,
    onEvent,
    messages,
    mode
  });

  return {
    content: reply.content || streamed,
    provider: reply.provider ?? provider,
    model: reply.model ?? model,
    buildRequest: reply.buildRequest ?? buildRequest
  };
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
