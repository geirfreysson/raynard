import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  fetchEventBySlug,
  fetchMarketBySlug,
  fetchMidpoint,
  fetchTrendingEvents,
  searchPolymarket,
} from './client.ts';

const market = {
  id: '1163699',
  slug: 'clarity-act-signed-into-law-in-2026',
  question: 'Clarity Act signed into law in 2026?',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.185", "0.815"]',
};

const event = {
  id: '158505',
  slug: 'clarity-act-signed-into-law-in-2026',
  title: 'Clarity Act signed into law in 2026?',
  volume24hr: 1926774.6,
  markets: [market],
};

test('fetchTrendingEvents calls the current keyset endpoint with literal sorting and paging parameters', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(
      url,
      'https://gamma-api.polymarket.com/events/keyset?limit=10&order=volume24hr&ascending=false&closed=false&after_cursor=NEXT&tag_slug=politics',
    );
    return { body: { events: [event], next_cursor: 'NEXT2' } };
  });
  try {
    const result = await fetchTrendingEvents({ limit: 10, after_cursor: 'NEXT', tag_slug: 'politics' });
    assert.equal(result.events[0]?.id, '158505');
    assert.equal(result.next_cursor, 'NEXT2');
  } finally { fetchMock.restore(); }
});

test('searchPolymarket calls public search with active-event filters and page controls', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(
      url,
      'https://gamma-api.polymarket.com/public-search?q=bitcoin&limit_per_type=5&page=2&events_status=active&keep_closed_markets=0&search_tags=false&search_profiles=false',
    );
    return { body: { events: [event], pagination: { hasMore: true, totalResults: 42 } } };
  });
  try {
    const result = await searchPolymarket({ q: 'bitcoin', limit_per_type: 5, page: 2 });
    assert.equal(result.events?.[0]?.slug, 'clarity-act-signed-into-law-in-2026');
    assert.equal(result.pagination?.totalResults, 42);
  } finally { fetchMock.restore(); }
});

test('fetchEventBySlug calls the literal event detail URL', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://gamma-api.polymarket.com/events/slug/clarity-act-signed-into-law-in-2026');
    return { body: event };
  });
  try {
    const result = await fetchEventBySlug('clarity-act-signed-into-law-in-2026');
    assert.equal(result.id, '158505');
  } finally { fetchMock.restore(); }
});

test('fetchMarketBySlug calls the literal market detail URL', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://gamma-api.polymarket.com/markets/slug/clarity-act-signed-into-law-in-2026');
    return { body: market };
  });
  try {
    const result = await fetchMarketBySlug('clarity-act-signed-into-law-in-2026');
    assert.equal(result.id, '1163699');
  } finally { fetchMock.restore(); }
});

test('fetchMidpoint calls the public CLOB midpoint endpoint with its token id', async () => {
  const fetchMock = mockFetch((url) => {
    assert.equal(url, 'https://clob.polymarket.com/midpoint?token_id=123456789');
    return { body: { mid: '0.185' } };
  });
  try {
    const result = await fetchMidpoint('123456789');
    assert.equal(result.mid, '0.185');
  } finally { fetchMock.restore(); }
});
