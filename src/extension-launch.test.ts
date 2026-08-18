import { describe, expect, it } from 'vitest';

import { shouldShowExtensionOnboarding } from './extension-launch';

describe('shouldShowExtensionOnboarding', () => {
  const available = {
    id: 'raynard.catalog.open-library',
    slug: 'open-library',
    installed: false
  };

  it('waits until an AI provider is connected', () => {
    expect(shouldShowExtensionOnboarding(false, [], [available])).toBe(false);
  });

  it('opens when a provider is connected and no extension is enabled or local', () => {
    expect(shouldShowExtensionOnboarding(true, [], [available])).toBe(true);
  });

  it('stays closed when the user has a locally authored extension', () => {
    expect(
      shouldShowExtensionOnboarding(
        true,
        [{ id: 'raynard.generated.notes', directory: '/plugins/notes' }],
        [available]
      )
    ).toBe(false);
  });

  it('stays closed when a catalog extension is installed', () => {
    expect(
      shouldShowExtensionOnboarding(true, [], [{ ...available, installed: true }])
    ).toBe(false);
  });
});
