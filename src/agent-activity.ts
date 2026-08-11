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
  /** Set while the turn is waiting out a transient provider failure. */
  retry?: { reason: string; attempt: number; maxAttempts: number };
};

/** What each provider failure reason is called in the status line. */
const RETRY_REASONS: Record<string, string> = {
  overloaded: 'The model is overloaded',
  rate_limited: 'The model provider is rate limiting us',
  unavailable: 'The model provider is unreachable',
  timeout: 'The model timed out'
};

/** The status line to show, or null when no indicator belongs on screen. */
export function agentActivityLabel(state: AgentActivity): string | null {
  if (!state?.running) return null;
  // A pending retry outranks everything. The turn is deliberately idle for the
  // length of the backoff, and saying so is the difference between a visible
  // wait and an app that looks hung.
  const retry = state.retry;
  if (retry) {
    const cause = RETRY_REASONS[retry.reason] || 'The model stopped';
    return `${cause} — retrying (${retry.attempt}/${retry.maxAttempts})…`;
  }
  // A tool call outranks streaming: text may already be on screen from an
  // earlier step while the agent goes back out to an API.
  const toolName = state.toolName?.trim();
  if (toolName) return `Calling ${toolName}…`;
  // Arriving text is its own proof of life.
  if (state.streaming) return null;
  return 'Working…';
}
