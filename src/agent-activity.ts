// Liveness label for an Explore-mode turn. Build mode already proves it is alive
// with a pulsing heartbeat (see renderBuilderRun); an ordinary chat turn showed
// nothing at all while an API tool ran, so a slow call was indistinguishable
// from a frozen app.
//
// Pure so the rules are testable; main.ts only mirrors the result into the DOM.

export type AgentActivity = {
  /** Tool currently executing, if any. */
  toolName?: string;
  /** True once the model has started streaming its answer. */
  streaming: boolean;
  /** False once the turn has finished, errored, or been stopped. */
  running: boolean;
};

/** The status line to show, or null when no indicator belongs on screen. */
export function agentActivityLabel(state: AgentActivity): string | null {
  if (!state?.running) return null;
  // A tool call outranks streaming: text may already be on screen from an
  // earlier step while the agent goes back out to an API.
  const toolName = state.toolName?.trim();
  if (toolName) return `Calling ${toolName}…`;
  // Arriving text is its own proof of life.
  if (state.streaming) return null;
  return 'Working…';
}
