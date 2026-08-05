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
      { name: 'dnd_get_monster', description: 'one monster', card: { name: { singular: 'monster', plural: 'monsters' } } },
      { name: 'dnd_list_monsters', description: 'list', card: null }
    ]
  }
];

describe('buildMentionItems', () => {
  it('emits plugin, tool, and card items with useful insert text', () => {
    const items = buildMentionItems(plugins);
    const plugin = items.find((i) => i.kind === 'plugin');
    const tool = items.find((i) => i.kind === 'tool' && i.label === 'dnd_get_monster');
    const card = items.find((i) => i.kind === 'card');

    expect(plugin?.insertText).toBe('dnd-5e-api');
    expect(tool?.insertText).toBe('dnd_get_monster');
    expect(card?.label).toBe('monster card');
    expect(card?.insertText).toBe('monster card');
    // A list tool (no card) yields a tool item but no card item.
    expect(items.filter((i) => i.kind === 'card')).toHaveLength(1);
  });
});

describe('filterMentionItems', () => {
  it('ranks prefix matches ahead of substring matches', () => {
    const items = buildMentionItems(plugins);
    const results = filterMentionItems(items, 'monster');
    // "monster card" (label prefix) and monster tool match; list tool matches by substring.
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].label.toLowerCase().startsWith('monster') || results[0].insertText.toLowerCase().startsWith('monster')).toBe(true);
  });

  it('matches plugins by slug', () => {
    const items = buildMentionItems(plugins);
    const results = filterMentionItems(items, 'dnd-5e');
    expect(results.some((r) => r.kind === 'plugin' && r.insertText === 'dnd-5e-api')).toBe(true);
  });
});
