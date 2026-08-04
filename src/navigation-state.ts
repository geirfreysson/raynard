export type ChatNavigationDecision = 'show-active' | 'block' | 'load';

export function decideChatNavigation(options: {
  targetChatId: string;
  activeChatId: string;
  isRunning: boolean;
}): ChatNavigationDecision {
  if (options.targetChatId === options.activeChatId) {
    return 'show-active';
  }
  return options.isRunning ? 'block' : 'load';
}
