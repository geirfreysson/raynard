// Tests for the Hacker News API fetch helpers in client.ts.
// All network access is mocked via the shared SDK's mockFetch helper.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  API_BASE,
  fetchTopStoryIds,
  fetchNewStoryIds,
  fetchBestStoryIds,
  fetchAskStoryIds,
  fetchShowStoryIds,
  fetchJobStoryIds,
  fetchItem,
  fetchItems,
  fetchUser,
  fetchMaxItemId,
  fetchUpdates
} from './client.ts';

const story = (id: number) => ({
  id,
  type: 'story',
  by: 'pg',
  time: 1175714200 + id,
  title: `Story ${id}`,
  score: 100 + id,
  descendants: id * 2,
  kids: [id * 100],
  url: `https://example.com/story-${id}`
});

test('the client targets the documented Hacker News host', async () => {
  // Every other assertion here is written against API_BASE and would follow a
  // base-URL rewrite. Pinning the literal origin once is what makes it fail.
  assert.equal(API_BASE, 'https://hacker-news.firebaseio.com/v0');
  const fetchMock = mockFetch(() => ({ body: [111] }));
  try {
    await fetchTopStoryIds();
    assert.equal(fetchMock.calls[0], 'https://hacker-news.firebaseio.com/v0/topstories.json');
  } finally {
    fetchMock.restore();
  }
});

test('story-id feed helpers hit the right endpoints and return id arrays', async () => {
  const feeds: Array<[(ids?: number[]) => Promise<number[]>, string]> = [
    [fetchTopStoryIds, 'topstories'],
    [fetchNewStoryIds, 'newstories'],
    [fetchBestStoryIds, 'beststories'],
    [fetchAskStoryIds, 'askstories'],
    [fetchShowStoryIds, 'showstories'],
    [fetchJobStoryIds, 'jobstories']
  ];
  for (const [helper, feed] of feeds) {
    const fetchMock = mockFetch((url) =>
      url === `${API_BASE}/${feed}.json` ? { body: [111, 222, 333] } : undefined
    );
    try {
      const ids = await helper();
      assert.deepEqual(ids, [111, 222, 333], `${feed} should return the mocked ids`);
      assert.deepEqual(fetchMock.calls, [`${API_BASE}/${feed}.json`]);
    } finally {
      fetchMock.restore();
    }
  }
});

test('feed helpers surface HTTP errors', async () => {
  const fetchMock = mockFetch(() => ({ status: 500, body: { error: 'boom' } }));
  try {
    await assert.rejects(() => fetchTopStoryIds(), /HTTP 500/);
  } finally {
    fetchMock.restore();
  }
});

test('fetchItem returns the item payload from /v0/item/<id>.json', async () => {
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/item/8863.json` ? { body: story(8863) } : undefined
  );
  try {
    const item = await fetchItem(8863);
    assert.equal(item?.id, 8863);
    assert.equal(item?.title, 'Story 8863');
    assert.equal(item?.type, 'story');
    assert.deepEqual(fetchMock.calls, [`${API_BASE}/item/8863.json`]);
  } finally {
    fetchMock.restore();
  }
});

test('fetchItem returns null for missing/deleted items', async () => {
  const fetchMock = mockFetch(() => ({ body: null }));
  try {
    const item = await fetchItem(404);
    assert.equal(item, null);
  } finally {
    fetchMock.restore();
  }
});

test('fetchItems fetches every id and drops null and deleted entries', async () => {
  const items: Record<number, unknown> = {
    1: story(1),
    2: null,
    3: { ...story(3), deleted: true },
    4: story(4)
  };
  const fetchMock = mockFetch((url) => {
    const match = url.match(/\/item\/(\d+)\.json$/);
    return match ? { body: items[Number(match[1])] } : undefined;
  });
  try {
    const result = await fetchItems([1, 2, 3, 4]);
    assert.deepEqual(
      result.map((i) => i.id),
      [1, 4]
    );
    assert.equal(fetchMock.calls.length, 4);
  } finally {
    fetchMock.restore();
  }
});

test('fetchUser returns the profile from /v0/user/<id>.json', async () => {
  const profile = { id: 'pg', created: 1160418092, karma: 155022, about: 'founder', submitted: [1, 2] };
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/user/pg.json` ? { body: profile } : undefined
  );
  try {
    const user = await fetchUser('pg');
    assert.equal(user?.id, 'pg');
    assert.equal(user?.karma, 155022);
    assert.deepEqual(fetchMock.calls, [`${API_BASE}/user/pg.json`]);
  } finally {
    fetchMock.restore();
  }
});

test('fetchUser returns null for unknown usernames', async () => {
  const fetchMock = mockFetch(() => ({ body: null }));
  try {
    assert.equal(await fetchUser('no-such-user'), null);
  } finally {
    fetchMock.restore();
  }
});

test('fetchMaxItemId returns the current largest item id', async () => {
  const fetchMock = mockFetch((url) =>
    url === `${API_BASE}/maxitem.json` ? { body: 40000001 } : undefined
  );
  try {
    assert.equal(await fetchMaxItemId(), 40000001);
    assert.deepEqual(fetchMock.calls, [`${API_BASE}/maxitem.json`]);
  } finally {
    fetchMock.restore();
  }
});

test('fetchUpdates returns changed item ids and profile names', async () => {
  const body = { items: [8423878, 8424305], profiles: ['pg', 'sama'] };
  const fetchMock = mockFetch((url) => (url === `${API_BASE}/updates.json` ? { body } : undefined));
  try {
    const updates = await fetchUpdates();
    assert.deepEqual(updates.items, [8423878, 8424305]);
    assert.deepEqual(updates.profiles, ['pg', 'sama']);
    assert.deepEqual(fetchMock.calls, [`${API_BASE}/updates.json`]);
  } finally {
    fetchMock.restore();
  }
});
