// Tests for every tool in the registry, with the network mocked via mockFetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';
import { API_BASE } from './client.ts';

const NOW = Math.floor(Date.now() / 1000);

const makeStory = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  type: 'story',
  by: `user${id}`,
  time: NOW - id * 60,
  title: `Story ${id}`,
  score: 100 + id,
  descendants: id * 3,
  kids: [id * 100, id * 100 + 1],
  url: `https://example.com/story-${id}`,
  ...overrides
});

/** Mock a story feed endpoint plus every item lookup. */
const mockFeed = (feed: string, ids: number[], items: Record<number, unknown>) =>
  mockFetch((url) => {
    if (url === `${API_BASE}/${feed}.json`) return { body: ids };
    const match = url.match(/\/item\/(\d+)\.json$/);
    if (match) return { body: items[Number(match[1])] ?? null };
    return undefined;
  });

// ---------------------------------------------------------------------------
// Feed list tools
// ---------------------------------------------------------------------------

const feedTools: Array<[string, string]> = [
  ['hn_list_top_stories', 'topstories'],
  ['hn_list_new_stories', 'newstories'],
  ['hn_list_best_stories', 'beststories'],
  ['hn_list_ask_stories', 'askstories'],
  ['hn_list_show_stories', 'showstories'],
  ['hn_list_job_stories', 'jobstories']
];

for (const [toolName, feed] of feedTools) {
  test(`${toolName} lists non-empty mocked ids and useful story text`, async () => {
    const ids = [101, 102, 103];
    const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
    const fetchMock = mockFeed(feed, ids, items);
    try {
      const result = await tools[toolName].execute({ limit: 3 });
      expectToolResult(result);
      assert.ok(tools[toolName].card, 'list tool must declare a card');
      const data = result.data as { count: number; stories: unknown[] };
      assert.equal(data.count, 3);
      assert.equal(data.stories.length, 3);
      for (const id of ids) {
        assert.match(result.text, new RegExp(`#${id}\\b`), 'text must show the story id');
        assert.match(result.text, new RegExp(`Story ${id}`), 'text must show the story title');
      }
      assert.match(result.text, /points/i);
      assert.equal(result.references.length, 3);
      assert.equal(result.references[0].referenceId, '101');
      assert.ok(result.references[0].referenceMeta.sourceUrl.includes('/item/101.json'));
    } finally {
      fetchMock.restore();
    }
  });
}

test('hn_list_top_stories honours the limit argument', async () => {
  const ids = [201, 202, 203, 204];
  const items = Object.fromEntries(ids.map((id) => [id, makeStory(id)]));
  const fetchMock = mockFeed('topstories', ids, items);
  try {
    const result = await tools.hn_list_top_stories.execute({ limit: 2 });
    expectToolResult(result);
    assert.equal(result.references.length, 2);
    assert.match(result.text, /#201\b/);
    assert.doesNotMatch(result.text, /#203\b/);
  } finally {
    fetchMock.restore();
  }
});

test('hn_list_top_stories skips deleted and missing items', async () => {
  const ids = [301, 302, 303];
  const items = {
    301: makeStory(301),
    302: { ...makeStory(302), deleted: true },
    303: null
  };
  const fetchMock = mockFeed('topstories', ids, items);
  try {
    const result = await tools.hn_list_top_stories.execute({ limit: 3 });
    expectToolResult(result);
    assert.equal(result.references.length, 1);
    assert.match(result.text, /#301\b/);
    assert.doesNotMatch(result.text, /#302\b/);
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// hn_search_stories
// ---------------------------------------------------------------------------

test('hn_search_stories filters by keyword and returns non-empty mocked ids', async () => {
  const ids = [401, 402, 403];
  const items = {
    401: makeStory(401, { title: 'Show HN: Lisp interpreter written in Rust' }),
    402: makeStory(402, { title: 'Rust in the Linux kernel' }),
    403: makeStory(403, { title: 'A guide to French cooking' })
  };
  const fetchMock = mockFeed('newstories', ids, items);
  try {
    const result = await tools.hn_search_stories.execute({ query: 'rust', feed: 'new' });
    expectToolResult(result);
    assert.ok(tools.hn_search_stories.card, 'search tool must declare a card');
    const data = result.data as { matchCount: number; stories: unknown[] };
    assert.equal(data.matchCount, 2);
    assert.equal(data.stories.length, 2);
    assert.equal(result.references.length, 2);
    assert.match(result.text, /#401\b/);
    assert.match(result.text, /#402\b/);
    assert.doesNotMatch(result.text, /#403\b/);
  } finally {
    fetchMock.restore();
  }
});

test('hn_search_stories filters by story type', async () => {
  const ids = [411, 412];
  const items = {
    411: makeStory(411, { type: 'job', title: 'Hiring: Rust engineer', url: 'https://example.com/jobs/1' }),
    412: makeStory(412, { type: 'story', title: 'Rust patterns' })
  };
  const fetchMock = mockFeed('topstories', ids, items);
  try {
    const result = await tools.hn_search_stories.execute({ feed: 'top', type: 'job' });
    expectToolResult(result);
    assert.equal(result.references.length, 1);
    assert.match(result.text, /#411\b/);
    assert.match(result.text, /\[job\]/);
  } finally {
    fetchMock.restore();
  }
});

test('hn_search_stories filters by time period', async () => {
  const ids = [421, 422];
  const items = {
    421: makeStory(421, { time: NOW - 30 * 60 }), // 30 minutes ago
    422: makeStory(422, { time: NOW - 3 * 24 * 3600 }) // 3 days ago
  };
  const fetchMock = mockFeed('newstories', ids, items);
  try {
    const result = await tools.hn_search_stories.execute({ feed: 'new', period: 'day' });
    expectToolResult(result);
    assert.equal(result.references.length, 1);
    assert.match(result.text, /#421\b/);
    assert.doesNotMatch(result.text, /#422\b/);
  } finally {
    fetchMock.restore();
  }
});

test('hn_search_stories filters by explicit minTime/maxTime window', async () => {
  const ids = [431, 432, 433];
  const items = {
    431: makeStory(431, { time: 1700000100 }),
    432: makeStory(432, { time: 1700000200 }),
    433: makeStory(433, { time: 1700000300 })
  };
  const fetchMock = mockFeed('beststories', ids, items);
  try {
    const result = await tools.hn_search_stories.execute({
      feed: 'best',
      minTime: 1700000150,
      maxTime: 1700000250
    });
    expectToolResult(result);
    assert.equal(result.references.length, 1);
    assert.match(result.text, /#432\b/);
  } finally {
    fetchMock.restore();
  }
});

test('hn_search_stories rejects an invalid feed', async () => {
  const fetchMock = mockFetch(() => ({ body: [] }));
  try {
    await assert.rejects(
      () => tools.hn_search_stories.execute({ feed: 'controversial' }),
      /feed must be one of/i
    );
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// hn_get_item
// ---------------------------------------------------------------------------

test('hn_get_item renders story details with card-bound data and a citation', async () => {
  const story = makeStory(8863, {
    title: 'My YC app: Dropbox',
    by: 'dhouston',
    score: 111,
    descendants: 71
  });
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/item/8863.json` ? { body: story } : undefined
  );
  try {
    const result = await tools.hn_get_item.execute({ id: 8863 });
    expectToolResult(result);
    assert.match(result.text, /My YC app: Dropbox/);
    assert.match(result.text, /111 points/);
    assert.match(result.text, /dhouston/);
    // Card is declared and every field it binds to exists in data.
    assert.ok(tools.hn_get_item.card, 'tool must declare a card');
    const data = result.data as Record<string, unknown>;
    assert.ok(data, 'tool must return data');
    for (const field of ['id', 'type', 'title', 'by', 'score', 'comments', 'url', 'posted', 'snippet']) {
      assert.ok(field in data, `data.${field} must exist for the card`);
    }
    assert.equal(data.id, 8863);
    assert.equal(data.score, 111);
    assert.equal(data.comments, 71);
    assert.equal(result.references[0].referenceId, '8863');
  } finally {
    fetchMock.restore();
  }
});

test('hn_get_item renders a comment with its parent link', async () => {
  const comment = {
    id: 9224,
    type: 'comment',
    by: 'tptacek',
    time: NOW - 120,
    text: 'It is a &#x27;bag of holding&#x27;<p>second paragraph',
    parent: 8863,
    kids: [9225]
  };
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/item/9224.json` ? { body: comment } : undefined
  );
  try {
    const result = await tools.hn_get_item.execute({ id: 9224 });
    expectToolResult(result);
    assert.match(result.text, /comment/i);
    assert.match(result.text, /tptacek/);
    assert.match(result.text, /parent #8863/);
    const data = result.data as Record<string, unknown>;
    assert.equal(data.type, 'comment');
    assert.equal(String(data.snippet).includes('<p>'), false, 'snippet must strip HTML tags');
    assert.match(String(data.snippet), /bag of holding/);
  } finally {
    fetchMock.restore();
  }
});

test('hn_get_item rejects invalid ids and missing items', async () => {
  const fetchMock = mockFetch(() => ({ body: null }));
  try {
    await assert.rejects(() => tools.hn_get_item.execute({ id: -5 }), /positive integer/);
    await assert.rejects(() => tools.hn_get_item.execute({ id: 999999 }), /not found/i);
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// hn_get_item_comments
// ---------------------------------------------------------------------------

test('hn_get_item_comments returns the discussion with card-bound data', async () => {
  const story = makeStory(5001, { title: 'Thread under test', descendants: 2, kids: [5101, 5102] });
  const comments: Record<number, unknown> = {
    5001: story,
    5101: { id: 5101, type: 'comment', by: 'alice', time: NOW - 300, text: 'First comment', parent: 5001 },
    5102: { id: 5102, type: 'comment', by: 'bob', time: NOW - 200, text: 'Second comment', parent: 5001 }
  };
  const fetchMock = mockFetch((url) => {
    const match = url.match(/\/item\/(\d+)\.json$/);
    return match ? { body: comments[Number(match[1])] ?? null } : undefined;
  });
  try {
    const result = await tools.hn_get_item_comments.execute({ id: 5001, limit: 5 });
    expectToolResult(result);
    assert.ok(tools.hn_get_item_comments.card, 'tool must declare a card');
    const data = result.data as Record<string, unknown>;
    assert.ok(data, 'tool must return data');
    for (const field of ['id', 'title', 'total', 'shown', 'comments']) {
      assert.ok(field in data, `data.${field} must exist for the card`);
    }
    const rows = data.comments as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].id, 5101);
    assert.equal(rows[0].author, 'alice');
    assert.match(result.text, /#5101\b/);
    assert.match(result.text, /First comment/);
    // Parent item + one citation per shown comment.
    assert.equal(result.references.length, 3);
  } finally {
    fetchMock.restore();
  }
});

test('hn_get_item_comments reports when there is no discussion', async () => {
  const story = makeStory(5002, { title: 'Quiet post', descendants: 0 });
  delete (story as Record<string, unknown>).kids;
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/item/5002.json` ? { body: story } : undefined
  );
  try {
    const result = await tools.hn_get_item_comments.execute({ id: 5002 });
    expectToolResult(result);
    assert.match(result.text, /no comments/i);
    const data = result.data as Record<string, unknown>;
    assert.deepEqual(data.comments, []);
    assert.equal(data.shown, 0);
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// hn_get_user
// ---------------------------------------------------------------------------

test('hn_get_user renders a profile with card-bound data and a citation', async () => {
  const profile = {
    id: 'pg',
    created: 1160418092,
    karma: 155022,
    about: 'Y Combinator founder',
    submitted: [1, 2, 3, 4]
  };
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/user/pg.json` ? { body: profile } : undefined
  );
  try {
    const result = await tools.hn_get_user.execute({ username: 'pg' });
    expectToolResult(result);
    assert.match(result.text, /pg/);
    assert.match(result.text, /155022/);
    assert.ok(tools.hn_get_user.card, 'tool must declare a card');
    const data = result.data as Record<string, unknown>;
    assert.ok(data, 'tool must return data');
    for (const field of ['id', 'karma', 'created', 'about', 'submittedCount']) {
      assert.ok(field in data, `data.${field} must exist for the card`);
    }
    assert.equal(data.karma, 155022);
    assert.equal(data.submittedCount, 4);
    assert.equal(result.references[0].referenceId, 'pg');
    assert.ok(result.references[0].referenceMeta.sourceUrl.includes('/user/pg.json'));
  } finally {
    fetchMock.restore();
  }
});

test('hn_get_user validates input and unknown users', async () => {
  const fetchMock = mockFetch(() => ({ body: null }));
  try {
    await assert.rejects(() => tools.hn_get_user.execute({ username: '  ' }), /non-empty/);
    await assert.rejects(() => tools.hn_get_user.execute({ username: 'ghost' }), /not found/i);
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// hn_get_max_item
// ---------------------------------------------------------------------------

test('hn_get_max_item returns the current largest item id', async () => {
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/maxitem.json` ? { body: 40000001 } : undefined
  );
  try {
    const result = await tools.hn_get_max_item.execute({});
    expectToolResult(result);
    assert.match(result.text, /40000001/);
    assert.ok(tools.hn_get_max_item.card, 'tool must declare a card');
    const data = result.data as Record<string, unknown>;
    assert.equal(data.maxItemId, 40000001);
    assert.equal(result.references[0].referenceId, 'maxitem');
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// hn_get_live_updates
// ---------------------------------------------------------------------------

test('hn_get_live_updates summarises changed items and profiles', async () => {
  const body = { items: [8423878, 8424305, 8424513], profiles: ['pg', 'sama'] };
  const fetchMock = mockFetch((url) => (url === `${API_BASE}/updates.json` ? { body } : undefined));
  try {
    const result = await tools.hn_get_live_updates.execute({});
    expectToolResult(result);
    assert.match(result.text, /3 items/);
    assert.match(result.text, /2 profiles/);
    assert.match(result.text, /8423878/);
    assert.match(result.text, /sama/);
    assert.ok(tools.hn_get_live_updates.card, 'tool must declare a card');
    const data = result.data as Record<string, unknown>;
    assert.equal(data.itemsChanged, 3);
    assert.equal(data.profilesChanged, 2);
    assert.deepEqual(data.itemIds, body.items);
    assert.deepEqual(data.profiles, body.profiles);
  } finally {
    fetchMock.restore();
  }
});

// ---------------------------------------------------------------------------
// Cross-cutting card contract
// ---------------------------------------------------------------------------

test('every tool returns data containing the fields its card binds to', () => {
  const cardFields = (card: { layout: unknown[] }): string[] => {
    const fields: string[] = [];
    const walk = (blocks: unknown[]) => {
      for (const block of blocks as Array<Record<string, unknown>>) {
        if (Array.isArray(block.items)) {
          for (const item of block.items as Array<Record<string, unknown>>) fields.push(String(item.field));
        }
        if (Array.isArray(block.pairs)) {
          for (const pair of block.pairs as Array<Record<string, unknown>>) fields.push(String(pair.field));
        }
        if (typeof block.field === 'string') fields.push(block.field);
        if (typeof block.rows === 'string') fields.push(block.rows);
        if (Array.isArray(block.layout)) walk(block.layout);
      }
    };
    walk(card.layout);
    return fields.map((f) => f.split('.')[0]);
  };
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.card, `${name} must declare a card`);
    const fields = cardFields(tool.card);
    assert.ok(fields.length > 0, `${name} card must bind at least one data field`);
  }
});
