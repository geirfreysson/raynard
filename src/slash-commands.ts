// Slash command autocomplete: the list of "/" commands the composer offers, and
// the prefix match that decides which of them the menu shows. Kept apart from
// main.ts so the matching rules are testable without a DOM; main.ts owns the
// menu markup and the handler each command runs.

export type SlashCommand = {
  /** The literal command text, including the leading slash. */
  command: string;
  /** Secondary display line in the menu. */
  description: string;
};

export const SLASH_COMMANDS: SlashCommand[] = [
  { command: '/extensions', description: 'Browse installed and bundled extensions' },
  { command: '/models', description: 'Connect or switch model providers' },
  { command: '/new', description: 'Start a new chat' },
  { command: '/settings', description: 'App version and updates' },
  { command: '/status', description: 'Token usage and provider quota' }
];

/**
 * The commands to offer for what has been typed so far. Matching is on the
 * whole input, not a token: the menu is only ever for a message that is
 * entirely one command, so trailing text (`/status extra`) offers nothing.
 */
export function filterSlashCommands(value: string): SlashCommand[] {
  const typed = String(value || '').trim().toLowerCase();
  if (!typed.startsWith('/')) return [];
  return SLASH_COMMANDS.filter((entry) => entry.command.startsWith(typed));
}
