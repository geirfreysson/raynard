import { describe, expect, it } from 'vitest';

import { extensionRemovalAction, groupExtensions } from './extension-groups';

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
