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

/**
 * Settle assistant messages left mid-run by a crash, a quit, or a turn whose
 * status was flipped back after it finished.
 *
 * Whatever the run had already produced is kept. The conversation the model
 * sees on the next turn is built from these `text` fields, so replacing them
 * with a notice throws away the work the user is about to ask it to continue —
 * one interrupted turn lost a finished answer, chart and all, that way. The
 * note goes in `error` instead, where it marks the turn without erasing it.
 */
export function recoverInterruptedMessages<T extends PersistedRunMessage>(messages: T[]) {
  let recovered = false;
  const next = messages.map((message) => {
    if (message.role !== 'assistant' || message.status !== 'running') return message;
    recovered = true;
    const streamed = String(message.text ?? '').trim();
    return {
      ...message,
      // Nothing streamed, so the notice is all there is to show.
      text: streamed || interruptedMessage,
      status: 'error' as const,
      error: interruptedMessage
    };
  });
  return { messages: next, recovered };
}
