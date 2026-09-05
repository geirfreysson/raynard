import { describe, expect, it } from 'vitest';

import {
  catalogExtensionHasUpdate,
  extensionRemovalAction,
  groupExtensions
} from './extension-groups';

describe('catalogExtensionHasUpdate', () => {
  it('offers an update when the bundled catalog moved past the installed snapshot', () => {
    expect(
      catalogExtensionHasUpdate({ installed: true, version: '0.4.0', installedVersion: '0.3.0' })
    ).toBe(true);
  });

  it('stays quiet when the installed copy already matches the catalog', () => {
    expect(
      catalogExtensionHasUpdate({ installed: true, version: '0.4.0', installedVersion: '0.4.0' })
    ).toBe(false);
    expect(
      catalogExtensionHasUpdate({ installed: true, version: ' 0.4.0 ', installedVersion: '0.4.0' })
    ).toBe(false);
  });

  it('never offers an update for an extension that is not installed', () => {
    expect(
      catalogExtensionHasUpdate({ installed: false, version: '0.4.0', installedVersion: '' })
    ).toBe(false);
  });

  it('offers an update when the installed manifest could not be read', () => {
    expect(
      catalogExtensionHasUpdate({ installed: true, version: '0.4.0', installedVersion: '' })
    ).toBe(true);
  });

  it('offers an update for a rolled-back release, not only a higher version', () => {
    expect(
      catalogExtensionHasUpdate({ installed: true, version: '0.3.0', installedVersion: '0.4.0' })
    ).toBe(true);
  });

  it('stays quiet when the catalog version is missing, since there is nothing to move to', () => {
    expect(
      catalogExtensionHasUpdate({ installed: true, version: '', installedVersion: '0.4.0' })
    ).toBe(false);
  });
});

describe('groupExtensions', () => {
  it('separates locally authored, installed catalog, and available catalog extensions', () => {
    const local = [
      {
        id: 'raynard.generated.weather-notes',
        directory: '/app-data/generated-plugins/weather-notes'
      },
      {
        id: 'raynard.catalog.open-library',
        directory: '/app-data/generated-plugins/open-library'
      }
    ];
    const catalog = [
      { id: 'raynard.catalog.open-library', slug: 'open-library', installed: true },
      { id: 'raynard.catalog.hacker-news', slug: 'hacker-news', installed: false }
    ];

    const grouped = groupExtensions(local, catalog);

    expect(grouped.yourExtensions.map((extension) => extension.id)).toEqual([
      'raynard.generated.weather-notes'
    ]);
    expect(grouped.installed.map((extension) => extension.slug)).toEqual(['open-library']);
    expect(grouped.available.map((extension) => extension.slug)).toEqual(['hacker-news']);
  });

  it('recognizes an installed catalog copy by directory slug after its manifest id is edited', () => {
    const local = [
      {
        id: 'customized.open-library',
        directory: String.raw`C:\app-data\generated-plugins\open-library`
      }
    ];
    const catalog = [
      { id: 'raynard.catalog.open-library', slug: 'open-library', installed: true }
    ];

    const grouped = groupExtensions(local, catalog);

    expect(grouped.yourExtensions).toEqual([]);
    expect(grouped.installed).toEqual(catalog);
  });

  it('uninstalls catalog copies and only deletes locally authored extensions', () => {
    const catalog = [
      { id: 'raynard.catalog.open-library', slug: 'open-library', installed: true }
    ];

    expect(
      extensionRemovalAction(
        {
          id: 'customized.open-library',
          directory: '/app-data/generated-plugins/open-library'
        },
        catalog
      )
    ).toBe('uninstall');
    expect(
      extensionRemovalAction(
        {
          id: 'raynard.generated.weather-notes',
          directory: '/app-data/generated-plugins/weather-notes'
        },
        catalog
      )
    ).toBe('delete');
  });
});
