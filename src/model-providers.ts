/**
 * How a provider row in `/models` presents itself.
 *
 * Providers connect in two different ways — a pasted API key, or a browser
 * sign-in — and the row has to say which before the user clicks. Keeping the
 * wording here rather than inline in the row template makes the full matrix
 * (auth method x connected x active) testable without a DOM.
 *
 * One provider now serves both roles: chat/explore and coding/build move
 * together, so a row has a single action rather than one per role.
 */

export type ModelRole = 'chat' | 'coding';

export type ProviderAuthMethod = 'api_key' | 'oauth';

export type ProviderRowState = {
  id: string;
  authMethod: ProviderAuthMethod;
  connected: boolean;
  chatActive: boolean;
  codingActive: boolean;
};

/**
 * The providers the picker offers, in the order it offers them.
 *
 * ChatGPT leads because it is the only one of the three that connects without
 * the user leaving to fetch a key from a billing console.
 */
export const PRIMARY_PROVIDER_IDS = ['openai-codex', 'claude', 'moonshot'] as const;

/** True when clicking the row's action has to authenticate first. */
export function providerNeedsAuth(provider: ProviderRowState): boolean {
  return !provider.connected;
}

/**
 * True when this provider is serving every role.
 *
 * Deliberately not `chatActive || codingActive`: a config written while the two
 * roles were chosen separately can point at different providers, and a row that
 * only holds one of them still has work to do when clicked.
 */
export function providerIsActive(provider: ProviderRowState): boolean {
  return provider.chatActive && provider.codingActive;
}

export function providerActionLabel(provider: ProviderRowState): string {
  if (providerNeedsAuth(provider)) {
    return provider.authMethod === 'oauth' ? 'Sign in' : 'Add key';
  }
  return providerIsActive(provider) ? 'Active' : 'Use';
}

/**
 * Whether to offer disconnecting.
 *
 * Only signed-in providers get this: an API key is replaced by pasting a new
 * one, but a stale OAuth token is invisible and has no other way out.
 */
export function providerCanSignOut(provider: ProviderRowState): boolean {
  return provider.authMethod === 'oauth' && provider.connected;
}

/**
 * Splits the host's provider list into the three shown rows and the rest.
 *
 * The remainder is not dead — api.openai.com is a working account type — but it
 * belongs behind a secondary link so the common case stays a three-way choice.
 */
export function partitionProviders<
  T extends { id: string; chatActive?: boolean; codingActive?: boolean }
>(providers: T[]): { primary: T[]; advanced: T[] } {
  // A provider that is actually in use is always a row, wherever it ranks. It
  // has an "Active" state to show and a name the user needs to recognise, and
  // neither survives being collapsed into a one-line link.
  const isPromoted = (provider: T) =>
    PRIMARY_PROVIDER_IDS.some((id) => id === provider.id) ||
    Boolean(provider.chatActive) ||
    Boolean(provider.codingActive);

  const rank = (provider: T) => {
    const index = PRIMARY_PROVIDER_IDS.findIndex((id) => id === provider.id);
    return index === -1 ? PRIMARY_PROVIDER_IDS.length : index;
  };

  const primary = providers.filter(isPromoted).sort((left, right) => rank(left) - rank(right));
  const advanced = providers.filter((provider) => !isPromoted(provider));
  return { primary, advanced };
}

/**
 * Whether the app has to ask for a provider before it can be used.
 *
 * Keyed on `connected`, which the host already reports as "a credential exists
 * somewhere" — keychain or `.env`. Anyone with a working setup, including a
 * developer running from an environment file, goes straight to the chat.
 */
export function needsProviderOnboarding(providers: { connected: boolean }[]): boolean {
  return !providers.some((provider) => provider.connected);
}
