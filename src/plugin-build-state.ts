export type ExistingPluginBuildState = {
  exists: boolean;
  hasRuntimeTools: boolean;
  status: string;
};

// A directory left behind by a failed fresh build is still a fresh build. Only
// plugins that expose runtime tools are safe to route through the lightweight
// interactive-edit path, which intentionally skips whole-plugin validation.
export function shouldUsePluginEditMode(state: ExistingPluginBuildState): boolean {
  return state.exists && state.hasRuntimeTools;
}

type PersistedRunMessage = {
  role: 'user' | 'assistant';
  text: string;
  status?: 'running' | 'completed' | 'error';
  error?: string;
};

const interruptedMessage = 'This run was interrupted before it completed.';

export function recoverInterruptedMessages<T extends PersistedRunMessage>(messages: T[]) {
  let recovered = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || message.status !== 'running') return message;
    recovered = true;
    return {
      ...message,
      text: interruptedMessage,
      status: 'error' as const,
      error: interruptedMessage
    };
  });
  return { messages: next, recovered };
}
