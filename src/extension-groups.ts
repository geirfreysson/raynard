export type LocalExtensionIdentity = {
  id: string;
  directory: string;
};

export type CatalogExtensionIdentity = {
  id: string;
  slug: string;
  installed: boolean;
};

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
