export type ExtensionRecommendation = {
  slug: string;
  name: string;
  description: string;
  answer: string;
};

export function decodeExtensionRecommendation(input: unknown): ExtensionRecommendation | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const slug = String(source.slug || '').trim();
  const name = String(source.name || '').trim();
  const answer = String(source.answer || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug) || !name || !answer) return null;
  return {
    slug,
    name,
    description: String(source.description || '').trim(),
    answer
  };
}
