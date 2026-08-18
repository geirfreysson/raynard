export function toggleExtensionSelection(
  selected: ReadonlySet<string>,
  slug: string
): Set<string> {
  const next = new Set(selected);
  if (next.has(slug)) {
    next.delete(slug);
  } else {
    next.add(slug);
  }
  return next;
}

export function extensionInstallActionLabel(count: number): string {
  if (count <= 0) return 'Select extensions';
  return `Install ${count} ${count === 1 ? 'extension' : 'extensions'}`;
}

export function shortExtensionDescription(description: string, limit = 72): string {
  const normalized = description.trim().replace(/\s+/g, ' ');
  if (normalized.length <= limit) return normalized;
  const clipped = normalized.slice(0, Math.max(1, limit - 1));
  const lastSpace = clipped.lastIndexOf(' ');
  const shortened = clipped
    .slice(0, lastSpace > limit / 2 ? lastSpace : clipped.length)
    .trimEnd()
    .replace(/[,:;.!?-]+$/, '');
  return `${shortened}…`;
}
