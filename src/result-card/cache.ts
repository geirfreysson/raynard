/** Read the host-owned cache provenance attached by the plugin runner. */
export function resultWasCached(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const metadata = (result as Record<string, unknown>)._raynard;
  if (!metadata || typeof metadata !== 'object') return false;
  return (metadata as Record<string, unknown>).cacheHit === true;
}
