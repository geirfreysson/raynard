import { describe, expect, it } from 'vitest';
import {
  EXTENSION_NAME_MAX_LENGTH,
  normalizeExtensionName,
  validateExtensionRename
} from './extension-rename';

const target = { id: 'dnd', name: 'D&D', directory: '/plugins/dnd' };

function others(...extras: Array<{ id: string; name: string; directory: string }>) {
  return [target, ...extras];
}

describe('normalizeExtensionName', () => {
  it('collapses whitespace and strips control characters', () => {
    expect(normalizeExtensionName('  Hacker\t\tNews \n')).toBe('Hacker News');
    expect(normalizeExtensionName('Hacker News')).toBe('Hacker News');
  });
});

describe('validateExtensionRename', () => {
  it('accepts a new name and reports that it changed', () => {
    const result = validateExtensionRename('  Dungeons & Dragons ', target, others());
    expect(result).toEqual({ ok: true, name: 'Dungeons & Dragons', changed: true });
  });

  it('accepts the current name but reports no change', () => {
    const result = validateExtensionRename('D&D', target, others());
    expect(result).toEqual({ ok: true, name: 'D&D', changed: false });
  });

  it('rejects an empty or whitespace-only name', () => {
    expect(validateExtensionRename('   ', target, others())).toEqual({
      ok: false,
      error: 'Enter a name for this extension.'
    });
  });

  it('rejects a name longer than the manifest limit', () => {
    const long = 'x'.repeat(EXTENSION_NAME_MAX_LENGTH + 1);
    expect(validateExtensionRename(long, target, others()).ok).toBe(false);
    expect(validateExtensionRename('x'.repeat(EXTENSION_NAME_MAX_LENGTH), target, others()).ok).toBe(
      true
    );
  });

  it('rejects a name another extension already displays, ignoring case', () => {
    const rivals = others({ id: 'hn', name: 'Hacker News', directory: '/plugins/hn' });
    expect(validateExtensionRename('hacker news', target, rivals)).toEqual({
      ok: false,
      error: 'Another extension already uses that name.'
    });
  });

  it('rejects a name that would resolve to another extension by id or directory', () => {
    const rivals = others({ id: 'hacker-news', name: 'HN', directory: '/plugins/news-reader' });
    expect(validateExtensionRename('hacker-news', target, rivals).ok).toBe(false);
    expect(validateExtensionRename('news-reader', target, rivals).ok).toBe(false);
  });

  it('ignores a collision with the extension being renamed', () => {
    expect(validateExtensionRename('dnd', target, others()).ok).toBe(true);
  });
});
