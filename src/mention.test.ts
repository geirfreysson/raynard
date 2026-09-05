import { describe, expect, it } from 'vitest';
import { buildMentionItems, filterMentionItems, getReferenceQueryAtCursor } from './mention';

describe('getReferenceQueryAtCursor', () => {
  it('detects an @token at the cursor and the range to replace', () => {
    const value = 'add cards to @dnd';
    const q = getReferenceQueryAtCursor(value, value.length);
    expect(q).toEqual({ query: 'dnd', replaceStart: 13, replaceEnd: 17 });
  });

  it('includes trailing token chars after the cursor in the replace range', () => {
    const value = 'edit @monster now';
    // cursor right after "@mon"
    const q = getReferenceQueryAtCursor(value, 9);
    expect(q?.query).toBe('mon');
    expect(value.slice(q!.replaceStart, q!.replaceEnd)).toBe('@monster');
  });

  it('returns null when the @ is glued to a previous token (e.g. an email)', () => {
    const value = 'ping bob@acme';
    expect(getReferenceQueryAtCursor(value, value.length)).toBeNull();
  });

  it('returns null when there is whitespace after the @', () => {
    const value = 'hey @ there';
    expect(getReferenceQueryAtCursor(value, value.length)).toBeNull();
  });
});

const plugins = [
  {
    id: 'raynard.generated.dnd-5e-api',
    name: 'Dnd 5e Api',
    directory: '/x/generated-plugins/dnd-5e-api',
    tools: [
      { name: 'dnd_get_monster', description: 'one monster' },
      { name: 'dnd_list_monsters', description: 'list' }
    ]
  }
];

describe('buildMentionItems', () => {
  it('emits exactly one plugin item per plugin, with useful insert text', () => {
    const items = buildMentionItems(plugins);
    expect(items).toHaveLength(1);
    const plugin = items.find((i) => i.kind === 'plugin');
    expect(plugin?.insertText).toBe('dnd-5e-api');
    expect(plugin?.label).toBe('Dnd 5e Api');
    expect(plugin?.description).toBe('plugin · dnd-5e-api · 2 tools');
  });
});

describe('filterMentionItems', () => {
  it('ranks prefix matches ahead of substring matches', () => {
    const items = buildMentionItems(plugins);
    const results = filterMentionItems(items, 'dnd');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].label.toLowerCase().startsWith('dnd') || results[0].insertText.toLowerCase().startsWith('dnd')).toBe(true);
  });

  it('matches plugins by slug', () => {
    const items = buildMentionItems(plugins);
    const results = filterMentionItems(items, 'dnd-5e');
    expect(results.some((r) => r.kind === 'plugin' && r.insertText === 'dnd-5e-api')).toBe(true);
  });

  it('can rank a plugin item and a bookmark item together for a shared query', () => {
    const items = [
      ...buildMentionItems(plugins),
      {
        kind: 'bookmark' as const,
        match: 'apple margins apple fy2024 margins',
        label: 'Apple FY2024 margins',
        description: 'bookmark · from a chat',
        insertText: 'apple-fy2024-margins-4f2a1c'
      }
    ];
    const results = filterMentionItems(items, 'a');
    expect(results.some((r) => r.kind === 'plugin')).toBe(true);
    expect(results.some((r) => r.kind === 'bookmark')).toBe(true);
  });
});
