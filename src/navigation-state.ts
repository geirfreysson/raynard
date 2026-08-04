export type ChatNavigationDecision = 'show-active' | 'block' | 'load';

export function decideChatNavigation(options: {
  targetChatId: string;
  activeChatId: string;
  isRunning: boolean;
}): ChatNavigationDecision {
  if (options.targetChatId === options.activeChatId) {
    return 'show-active';
  }
  // A running turn is bound to its own chat and persists there independently, so
  // viewing another saved chat mid-run is always safe. Starting a new turn is
  // still gated separately by the caller (isRunning) — navigation never is.
  return 'load';
}
