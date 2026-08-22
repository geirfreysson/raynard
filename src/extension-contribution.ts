export type ExtensionContributionMetadata = {
  category: string;
  tags: string[];
  icon: string;
  author: string;
  homepage: string;
};

type ContributionPlugin = {
  name: string;
  directory: string;
};

type CatalogMetadata = Pick<ExtensionContributionMetadata, 'category' | 'tags' | 'icon'>;

const CATALOG_ICONS = new Set(['book-open', 'database', 'message-square']);

function sourceUrls(manifest: unknown): string[] {
  if (!manifest || typeof manifest !== 'object' || !('sourceUrls' in manifest)) return [];
  const value = (manifest as { sourceUrls?: unknown }).sourceUrls;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.startsWith('https://'))
    : [];
}

function contributionSlug(plugin: ContributionPlugin) {
  const directorySlug = plugin.directory.split(/[\\/]/).filter(Boolean).at(-1) ?? '';
  const value = directorySlug || plugin.name;
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function catalogMetadata(manifest: unknown): CatalogMetadata | null {
  if (!manifest || typeof manifest !== 'object' || !('catalogMetadata' in manifest)) return null;
  const value = (manifest as { catalogMetadata?: unknown }).catalogMetadata;
  if (!value || typeof value !== 'object') return null;
  const metadata = value as { category?: unknown; tags?: unknown; icon?: unknown };
  const category = typeof metadata.category === 'string' ? metadata.category.trim() : '';
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((tag): tag is string => typeof tag === 'string')
    : [];
  const icon = typeof metadata.icon === 'string' ? metadata.icon.trim() : '';
  if (
    !category ||
    tags.length < 4 ||
    tags.length > 7 ||
    new Set(tags).size !== tags.length ||
    tags.some((tag) => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) ||
    !tags.includes('api') ||
    !CATALOG_ICONS.has(icon)
  ) {
    return null;
  }
  return { category, tags, icon };
}

export function contributionDefaults(
  plugin: ContributionPlugin,
  manifest: unknown
): ExtensionContributionMetadata {
  const suggested = catalogMetadata(manifest);
  return {
    category: suggested?.category ?? 'Data',
    tags:
      suggested?.tags ??
      [contributionSlug(plugin), 'api'].filter(
        (tag, index, tags) => tag && tags.indexOf(tag) === index
      ),
    icon: suggested?.icon ?? 'database',
    author: '',
    homepage: sourceUrls(manifest)[0] ?? ''
  };
}

export function parseContributionTags(value: string): string[] {
  return value
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag, index, tags) => Boolean(tag) && tags.indexOf(tag) === index);
}
