// A durable fact the agent proposed remembering, correcting, or forgetting.
// Every change is user-confirmed before it is saved — there is no user-facing
// edit form, only the agent's own proposal and a Save/Discard choice — and
// each entry is scoped to "global" or a specific installed plugin, never
// concatenated into one growing blob.

export type StoredMemory = {
  id: string;
  scope: string;
  content: string;
  scopeLabel: string;
  createdAt: number;
  updatedAt: number;
};

export type MemoryChangeRequest = {
  action: 'create' | 'update' | 'delete';
  memoryId?: string;
  content?: string;
  scope: string;
  scopeLabel: string;
};

export function decodeMemoryChangeRequest(input: unknown): MemoryChangeRequest | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Record<string, unknown>;
  const action = String(source.action || '').trim();
  if (action !== 'create' && action !== 'update' && action !== 'delete') return null;
  const memoryId = String(source.memoryId || '').trim();
  const content = String(source.content || '').trim();
  if ((action === 'update' || action === 'delete') && !memoryId) return null;
  if ((action === 'create' || action === 'update') && !content) return null;
  return {
    action,
    memoryId: memoryId || undefined,
    content: content || undefined,
    scope: String(source.scope || '').trim() || 'global',
    scopeLabel: String(source.scopeLabel || '').trim()
  };
}

/** The label a memory is grouped/displayed under. */
export function memoryScopeDisplayName(memory: Pick<StoredMemory, 'scope' | 'scopeLabel'>): string {
  if (memory.scope === 'global') return 'Global';
  return memory.scopeLabel || memory.scope;
}
