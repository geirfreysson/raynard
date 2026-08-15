import { describe, expect, it } from 'vitest';
import {
  needsProviderOnboarding,
  partitionProviders,
  providerActionLabel,
  providerCanSignOut,
  providerNeedsAuth,
  type ProviderRowState
} from './model-providers';

function row(overrides: Partial<ProviderRowState> = {}): ProviderRowState {
  return {
    id: 'claude',
    authMethod: 'api_key',
    connected: false,
    chatActive: false,
    codingActive: false,
    ...overrides
  };
}

describe('model provider rows', () => {
  it('asks for a key or a sign-in depending on how the provider authenticates', () => {
    expect(providerActionLabel(row({ authMethod: 'api_key' }))).toBe('Add key');
    expect(providerActionLabel(row({ authMethod: 'oauth' }))).toBe('Sign in');
  });

  it('offers one action per provider once it is connected', () => {
    expect(providerActionLabel(row({ connected: true }))).toBe('Use');
    expect(providerActionLabel(row({ connected: true, chatActive: true, codingActive: true }))).toBe(
      'Active'
    );
  });

  it('still offers a provider that only half of an older split config points at', () => {
    // Configs written before chat and coding moved together can name one
    // provider for chat and another for coding. Clicking the row repairs that,
    // so it must not present itself as already active.
    expect(providerActionLabel(row({ connected: true, chatActive: true }))).toBe('Use');
    expect(providerActionLabel(row({ connected: true, codingActive: true }))).toBe('Use');
  });

  it('says a signed-in provider is connected, however it authenticated', () => {
    expect(providerNeedsAuth(row({ authMethod: 'oauth', connected: true }))).toBe(false);
    expect(providerNeedsAuth(row({ authMethod: 'oauth', connected: false }))).toBe(true);
    expect(providerNeedsAuth(row({ authMethod: 'api_key', connected: true }))).toBe(false);
  });

  it('offers sign-out only where there is no other way to clear the credential', () => {
    expect(providerCanSignOut(row({ authMethod: 'oauth', connected: true }))).toBe(true);
    expect(providerCanSignOut(row({ authMethod: 'oauth', connected: false }))).toBe(false);
    // An API key is replaced by pasting a new one.
    expect(providerCanSignOut(row({ authMethod: 'api_key', connected: true }))).toBe(false);
  });
});

describe('provider list shape', () => {
  const providers = [
    { id: 'openai' },
    { id: 'openai-codex' },
    { id: 'claude' },
    { id: 'moonshot' }
  ];

  it('shows three providers in sign-in-first order and demotes the rest', () => {
    const { primary, advanced } = partitionProviders(providers);
    expect(primary.map((provider) => provider.id)).toEqual(['openai-codex', 'claude', 'moonshot']);
    // api.openai.com still works, but a ChatGPT subscription is the path we
    // want people on, so the key-based OpenAI account is not a fourth row.
    expect(advanced.map((provider) => provider.id)).toEqual(['openai']);
  });

  it('keeps the primary order regardless of the order the host returns', () => {
    const { primary } = partitionProviders([{ id: 'moonshot' }, { id: 'openai-codex' }]);
    expect(primary.map((provider) => provider.id)).toEqual(['openai-codex', 'moonshot']);
  });

  it('promotes a demoted provider that is actually in use', () => {
    // Otherwise the one provider the app is running on has no row, no "Active"
    // state, and no visible name.
    const { primary, advanced } = partitionProviders([
      { id: 'openai', chatActive: true, codingActive: true },
      { id: 'openai-codex' }
    ]);
    expect(primary.map((provider) => provider.id)).toEqual(['openai-codex', 'openai']);
    expect(advanced).toEqual([]);
  });
});

describe('first-run gate', () => {
  it('onboards only when no provider can be used at all', () => {
    expect(needsProviderOnboarding([row(), row({ id: 'openai-codex', authMethod: 'oauth' })])).toBe(
      true
    );
    expect(needsProviderOnboarding([])).toBe(true);
  });

  it('stays out of the way once anything is connected', () => {
    // `connected` already covers a key resolved from .env, so a developer with
    // an environment file never meets the splash.
    expect(needsProviderOnboarding([row(), row({ connected: true })])).toBe(false);
  });
});
