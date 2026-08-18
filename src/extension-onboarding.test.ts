import { describe, expect, it } from 'vitest';

import {
  extensionInstallActionLabel,
  shortExtensionDescription,
  toggleExtensionSelection
} from './extension-onboarding';

describe('extension onboarding', () => {
  it('toggles a catalog extension without mutating the previous selection', () => {
    const selected = new Set(['open-library']);

    const added = toggleExtensionSelection(selected, 'hacker-news');
    const removed = toggleExtensionSelection(added, 'open-library');

    expect([...selected]).toEqual(['open-library']);
    expect([...added]).toEqual(['open-library', 'hacker-news']);
    expect([...removed]).toEqual(['hacker-news']);
  });

  it('labels the install action for zero, one, and several selections', () => {
    expect(extensionInstallActionLabel(0)).toBe('Select extensions');
    expect(extensionInstallActionLabel(1)).toBe('Install 1 extension');
    expect(extensionInstallActionLabel(3)).toBe('Install 3 extensions');
  });

  it('keeps tile descriptions short and ends them cleanly', () => {
    const description =
      'Browse Dungeons & Dragons rules, spells, monsters, classes, equipment, and other resources through the public API.';

    expect(shortExtensionDescription(description, 64)).toBe(
      'Browse Dungeons & Dragons rules, spells, monsters, classes…'
    );
    expect(shortExtensionDescription('Search public books.', 64)).toBe('Search public books.');
  });
});
