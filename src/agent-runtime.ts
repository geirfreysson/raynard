import { Channel, invoke } from '@tauri-apps/api/core';

export type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type AgentReply = {
  content: string;
  provider?: string;
  model?: string;
};

export type StreamPayload = {
  stream_id: string;
  event_type: 'delta' | 'thinking_delta' | 'done' | 'error';
  delta?: string | null;
  text?: string | null;
  error?: string | null;
  provider?: string | null;
  model?: string | null;
};

export type AgentStreamHandlers = {
  onDelta?: (delta: string) => void;
  onThinkingDelta?: (delta: string) => void;
  onStreamId?: (streamId: string) => void;
};

export type PluginBuilderRequest = {
  pluginDir: string;
  name: string;
  description: string;
  sourceUrls: string[];
  prompt: string;
};

export async function runAgentTurn(messages: ChatMessage[]): Promise<AgentReply> {
  return invoke<AgentReply>('run_model_chat', { messages });
}

export async function runAgentTurnStream(
  messages: ChatMessage[],
  handlers: AgentStreamHandlers = {}
): Promise<AgentReply> {
  const streamId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `stream-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

  const reply = await invoke<AgentReply>('run_model_chat_stream', {
    streamId,
    onEvent,
    messages
  });

  return {
    content: reply.content || streamed,
    provider: reply.provider ?? provider,
    model: reply.model ?? model
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
