import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';

const market = {
  id: '1163699',
  slug: 'clarity-act-signed-into-law-in-2026',
  question: 'Clarity Act signed into law in 2026?',
  description: 'Resolves Yes if the act is signed into law by the deadline.',
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.185", "0.815"]',
  clobTokenIds: '["YES_TOKEN", "NO_TOKEN"]',
  active: true,
  closed: false,
  acceptingOrders: true,
  lastTradePrice: 0.18,
  bestBid: 0.18,
  bestAsk: 0.19,
  spread: 0.01,
  oneDayPriceChange: -0.05,
  volume24hr: 1926774.6,
  volumeNum: 9947013.8,
  liquidityNum: 491052.3,
  endDate: '2027-01-01T05:00:00Z',
  image: 'https://example.com/market.jpg',
  events: [{ id: '158505', slug: 'clarity-act-signed-into-law-in-2026', title: 'Clarity Act event' }],
};

const event = {
  id: '158505',
  slug: 'clarity-act-signed-into-law-in-2026',
  title: 'Clarity Act signed into law in 2026?',
  description: 'An event about whether the act becomes law.',
  active: true,
  closed: false,
  volume24hr: 1926774.6,
  volume: 9947013.8,
  liquidity: 491052.3,
  endDate: '2027-01-01T05:00:00Z',
  image: 'https://example.com/event.jpg',
  tags: [{ id: '2', label: 'Politics', slug: 'politics' }],
  markets: [market],
};

function bindPath(data, path) {
  const value = path.split('.').reduce((current, key) => current?.[key], data);
  assert.notEqual(value, undefined, `missing card-bound data field ${path}`);
}

function assertCardData(tool, data) {
  const visit = (block) => {
    if (block.component === 'MetricRow') block.items.forEach((item) => bindPath(data, item.field));
    if (block.component === 'KeyValue') block.pairs.forEach((pair) => bindPath(data, pair.field));
    if (block.component === 'Table') bindPath(data, block.rows);
    if (['Image', 'Badge', 'Json'].includes(block.component) && block.field) bindPath(data, block.field);
    if (block.layout) block.layout.forEach(visit);
    if (block.columns) block.columns.forEach((column) => column.layout?.forEach(visit));
  };
  tool.card.layout.forEach(visit);
}

test('polymarket_trending_events renders volume-ranked active events and current market probabilities', async () => {
  const fetchMock = mockFetch(() => ({ body: { events: [event], next_cursor: 'NEXT' } }));
  try {
    const result = await tools.polymarket_trending_events.execute({ limit: 10 });
    expectToolResult(result);
    assert.equal(fetchMock.calls[0], 'https://gamma-api.polymarket.com/events/keyset?limit=10&order=volume24hr&ascending=false&closed=false');
    assert.match(result.text, /Clarity Act/);
    assert.match(result.text, /18\.5%/);
    assert.equal(result.data.events[0].id, '158505');
    assert.equal(result.data.events[0].top_probability, '18.5%');
    assertCardData(tools.polymarket_trending_events, result.data);
  } finally { fetchMock.restore(); }
});

test('polymarket_search finds active events and provides slugs for detail calls', async () => {
  const fetchMock = mockFetch(() => ({ body: { events: [event], pagination: { hasMore: false, totalResults: 1 } } }));
  try {
    const result = await tools.polymarket_search.execute({ query: 'clarity act', limit: 5 });
    expectToolResult(result);
    assert.match(fetchMock.calls[0], /q=clarity\+act/);
    assert.match(result.text, /clarity-act-signed-into-law-in-2026/);
    assert.equal(result.data.events[0].featured_market_slug, market.slug);
    assert.equal(result.data.total_results, 1);
    assertCardData(tools.polymarket_search, result.data);
  } finally { fetchMock.restore(); }
});

test('polymarket_get_event renders every market and its aligned outcome probabilities', async () => {
  const fetchMock = mockFetch(() => ({ body: event }));
  try {
    const result = await tools.polymarket_get_event.execute({ slug: event.slug });
    expectToolResult(result);
    assert.match(result.text, /Yes 18\.5%/);
    assert.equal(result.data.markets[0].market_slug, market.slug);
    assert.equal(result.data.markets[0].outcomes, 'Yes 18.5% · No 81.5%');
    assertCardData(tools.polymarket_get_event, result.data);
  } finally { fetchMock.restore(); }
});

test('polymarket_get_market renders current outcome prices and CLOB token ids', async () => {
  const fetchMock = mockFetch(() => ({ body: market }));
  try {
    const result = await tools.polymarket_get_market.execute({ slug: market.slug });
    expectToolResult(result);
    assert.match(result.text, /market-implied/);
    assert.equal(result.data.outcomes[0].token_id, 'YES_TOKEN');
    assert.equal(result.data.outcomes[0].probability, '18.5%');
    assert.equal(result.data.best_bid, '18.0%');
    assertCardData(tools.polymarket_get_market, result.data);
  } finally { fetchMock.restore(); }
});

test('polymarket_get_live_midpoint renders the current public order-book midpoint', async () => {
  const fetchMock = mockFetch(() => ({ body: { mid: '0.185' } }));
  try {
    const result = await tools.polymarket_get_live_midpoint.execute({ token_id: 'YES_TOKEN' });
    expectToolResult(result);
    assert.equal(fetchMock.calls[0], 'https://clob.polymarket.com/midpoint?token_id=YES_TOKEN');
    assert.equal(result.data.probability, '18.5%');
    assert.match(result.text, /18\.5%/);
    assertCardData(tools.polymarket_get_live_midpoint, result.data);
  } finally { fetchMock.restore(); }
});
