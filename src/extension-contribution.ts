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

export function contributionDefaults(
  plugin: ContributionPlugin,
  manifest: unknown
): ExtensionContributionMetadata {
  return {
    category: 'Data',
    tags: [contributionSlug(plugin), 'api'].filter((tag, index, tags) => tag && tags.indexOf(tag) === index),
    icon: 'database',
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
