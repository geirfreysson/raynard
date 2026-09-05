import { describe, expect, it } from 'vitest';
import { decodeMemoryChangeRequest, memoryScopeDisplayName } from './memory';

describe('decodeMemoryChangeRequest', () => {
  it('decodes a valid create request', () => {
    const request = decodeMemoryChangeRequest({
      action: 'create',
      content: 'Prefers concise answers.',
      scope: 'global',
      scopeLabel: ''
    });
    expect(request).toEqual({
      action: 'create',
      memoryId: undefined,
      content: 'Prefers concise answers.',
      scope: 'global',
      scopeLabel: ''
    });
  });

  it('rejects a create with no content', () => {
    expect(decodeMemoryChangeRequest({ action: 'create', scope: 'global' })).toBeNull();
  });

  it('rejects an update/delete with no memoryId', () => {
    expect(decodeMemoryChangeRequest({ action: 'update', content: 'x', scope: 'global' })).toBeNull();
    expect(decodeMemoryChangeRequest({ action: 'delete', scope: 'global' })).toBeNull();
  });

  it('rejects an unknown action', () => {
    expect(decodeMemoryChangeRequest({ action: 'archive', content: 'x' })).toBeNull();
  });

  it('rejects non-object input', () => {
    expect(decodeMemoryChangeRequest(null)).toBeNull();
    expect(decodeMemoryChangeRequest('create')).toBeNull();
  });

  it('defaults an empty scope to global', () => {
    const request = decodeMemoryChangeRequest({ action: 'create', content: 'x', scope: '' });
    expect(request?.scope).toBe('global');
  });
});

describe('memoryScopeDisplayName', () => {
  it('shows "Global" for the global scope', () => {
    expect(memoryScopeDisplayName({ scope: 'global', scopeLabel: '' })).toBe('Global');
  });

  it('falls back to the raw scope slug when scopeLabel is missing', () => {
    expect(memoryScopeDisplayName({ scope: 'world-bank-data360', scopeLabel: '' })).toBe(
      'world-bank-data360'
    );
  });

  it('prefers the captured display name over the slug', () => {
    expect(
      memoryScopeDisplayName({ scope: 'world-bank-data360', scopeLabel: 'World Bank Data360' })
    ).toBe('World Bank Data360');
  });
});
