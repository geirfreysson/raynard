export type LocalExtensionIdentity = {
  id: string;
  directory: string;
};

export type CatalogExtensionIdentity = {
  id: string;
  slug: string;
  installed: boolean;
};

export type CatalogExtensionVersions = {
  installed: boolean;
  version: string;
  installedVersion: string;
};

/**
 * Whether the bundled catalog carries a different build than the installed copy.
 *
 * An installed extension is a snapshot taken at install time that nothing
 * refreshes, so a new app release ships updated files the user never sees. Any
 * difference counts, not only a higher version: a rolled-back release still has
 * to reach the user, and an unreadable installed manifest reports an empty
 * version, which is exactly the broken state an update repairs.
 */
export function catalogExtensionHasUpdate(extension: CatalogExtensionVersions): boolean {
  if (!extension.installed) return false;
  const catalog = String(extension.version ?? '').trim();
  const installed = String(extension.installedVersion ?? '').trim();
  if (!catalog) return false;
  return catalog !== installed;
}

function directorySlug(directory: string): string {
  return String(directory || '')
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .at(-1) ?? '';
}

export function catalogExtensionMatches(
  local: LocalExtensionIdentity,
  catalog: CatalogExtensionIdentity
): boolean {
  return local.id === catalog.id || directorySlug(local.directory) === catalog.slug;
}

export function extensionRemovalAction(
  local: LocalExtensionIdentity,
  catalogExtensions: CatalogExtensionIdentity[]
): 'delete' | 'uninstall' {
  return catalogExtensions.some(
    (catalog) => catalog.installed && catalogExtensionMatches(local, catalog)
  )
    ? 'uninstall'
    : 'delete';
}

export function groupExtensions<
  Local extends LocalExtensionIdentity,
  Catalog extends CatalogExtensionIdentity
>(localExtensions: Local[], catalogExtensions: Catalog[]) {
  const installed = catalogExtensions.filter((extension) => extension.installed);
  const available = catalogExtensions.filter((extension) => !extension.installed);
  const yourExtensions = localExtensions.filter(
    (local) => !installed.some((catalog) => catalogExtensionMatches(local, catalog))
  );

  return { yourExtensions, installed, available };
}
