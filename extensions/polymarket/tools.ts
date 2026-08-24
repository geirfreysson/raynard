import {
  createApiReference,
  defineTools,
  requireNonEmpty,
  requirePositiveInt,
  type CardTemplate,
} from '@raynard/plugin-sdk';
import {
  CLOB_BASE_URL,
  GAMMA_BASE_URL,
  fetchEventBySlug,
  fetchMarketBySlug,
  fetchMidpoint,
  fetchTrendingEvents,
  searchPolymarket,
  type GammaEvent,
  type GammaMarket,
} from './client.ts';

const probabilityNote = 'Market-implied probability from current contract prices; not an objective forecast or guarantee.';

function boundedInt(value: unknown, label: string, fallback: number, min: number, max: number) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = requirePositiveInt(value, label);
  if (parsed < min || parsed > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return parsed;
}

function numberValue(value: unknown) {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function optionalNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function percent(value: unknown) {
  const parsed = optionalNumber(value);
  return parsed === undefined ? '' : `${(parsed * 100).toFixed(1)}%`;
}

function usd(value: unknown) {
  const parsed = optionalNumber(value);
  return parsed === undefined
    ? ''
    : `$${parsed.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

function parsedArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function outcomeRows(market: GammaMarket) {
  const outcomes = parsedArray(market.outcomes);
  const prices = parsedArray(market.outcomePrices);
  const tokenIds = parsedArray(market.clobTokenIds);
  return outcomes.map((outcome, index) => ({
    outcome,
    price: optionalNumber(prices[index]) ?? '',
    probability: percent(prices[index]),
    token_id: tokenIds[index] ?? '',
  }));
}

function featuredMarket(event: GammaEvent) {
  const markets = [...(event.markets ?? [])];
  markets.sort((left, right) => numberValue(right.volume24hr) - numberValue(left.volume24hr));
  const market = markets[0];
  if (!market) return undefined;
  const outcomes = outcomeRows(market);
  const yes = outcomes.find((row) => row.outcome.toLowerCase() === 'yes');
  const priced = [...outcomes].sort((left, right) => numberValue(right.price) - numberValue(left.price));
  return { market, outcome: yes ?? priced[0] };
}

function eventUrl(event: GammaEvent) {
  return event.slug ? `https://polymarket.com/event/${event.slug}` : `${GAMMA_BASE_URL}/events/${event.id}`;
}

function eventRow(event: GammaEvent) {
  const featured = featuredMarket(event);
  return {
    id: event.id,
    slug: event.slug ?? '',
    title: event.title ?? event.slug ?? `Event ${event.id}`,
    volume_24h: usd(event.volume24hr),
    volume_24h_value: numberValue(event.volume24hr),
    total_volume: usd(event.volume),
    liquidity: usd(event.liquidity),
    markets_count: event.markets?.length ?? 0,
    featured_market: featured?.market.question ?? '',
    featured_market_slug: featured?.market.slug ?? '',
    top_outcome: featured?.outcome?.outcome ?? '',
    top_probability: featured?.outcome?.probability ?? '',
    end_date: event.endDate ?? '',
    url: eventUrl(event),
  };
}

function marketRow(market: GammaMarket) {
  const outcomes = outcomeRows(market);
  const yes = outcomes.find((row) => row.outcome.toLowerCase() === 'yes');
  const priced = [...outcomes].sort((left, right) => numberValue(right.price) - numberValue(left.price));
  const primary = yes ?? priced[0];
  return {
    id: market.id,
    market_slug: market.slug ?? '',
    question: market.question ?? market.slug ?? `Market ${market.id}`,
    primary_outcome: primary?.outcome ?? '',
    primary_probability: primary?.probability ?? '',
    outcomes: outcomes.map((row) => `${row.outcome} ${row.probability || 'unpriced'}`).join(' · '),
    volume_24h: usd(market.volume24hr),
    liquidity: usd(market.liquidityNum ?? market.liquidity),
    end_date: market.endDate ?? '',
    active: Boolean(market.active),
    closed: Boolean(market.closed),
  };
}

function eventReference(event: GammaEvent) {
  return createApiReference({
    id: `polymarket-event-${event.id}`,
    label: event.title ?? event.slug ?? `Polymarket event ${event.id}`,
    sourceUrl: eventUrl(event),
    quote: event.title ?? event.slug ?? `Event ${event.id}`,
    payload: event,
  });
}

function fallbackReference(id: string, label: string, sourceUrl: string, payload: unknown) {
  return createApiReference({ id, label, sourceUrl, quote: label, payload });
}

const eventListCard: CardTemplate = {
  name: { singular: 'event', plural: 'events' },
  title: '{{title}}',
  layout: [
    { component: 'Text', text: '{{probability_note}}' },
    { component: 'MetricRow', items: [
      { label: 'Returned', field: 'count' },
      { label: 'Total results', field: 'total_results' },
      { label: 'More available', field: 'has_more', tone: 'muted' },
    ] },
    { component: 'Table', rows: 'events', columns: [
      { header: 'Event', field: 'title' },
      { header: '24h volume', field: 'volume_24h' },
      { header: 'Markets', field: 'markets_count' },
      { header: 'Featured market', field: 'featured_market' },
      { header: 'Market slug', field: 'featured_market_slug' },
      { header: 'Outcome', field: 'top_outcome' },
      { header: 'Implied', field: 'top_probability' },
      { header: 'Slug', field: 'slug' },
    ] },
  ],
};

export const tools = defineTools({
  polymarket_trending_events: {
    description: 'List current active Polymarket events ranked by descending 24-hour trading volume using the non-deprecated Gamma /events/keyset endpoint. This is the plugin definition of “trending”: trading activity, not editorial popularity. Each event includes a preview of its highest-24h-volume market and that market’s Yes price when available (otherwise its highest-priced outcome). Prices are market-implied probabilities, can change, and are not factual forecasts. Defaults to 10 events, returns an opaque next_cursor for stable paging, and needs no credential. Use polymarket_get_event with an event slug to inspect every market and resolution wording.',
    parameters: { type: 'object', properties: {
      limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Number of volume-ranked events to return. Defaults to 10; this tool caps the documented API maximum at 25 to keep cards and model text bounded.' },
      tag_slug: { type: 'string', description: 'Optional exact Polymarket tag slug such as politics, crypto, sports, or elections. It filters before volume ranking; omit for all topics.' },
      next_cursor: { type: 'string', description: 'Opaque next_cursor returned by the previous call with the same limit and tag filter. Keyset pagination does not accept numeric offsets.' },
    } },
    card: eventListCard,
    async execute(args) {
      const limit = boundedInt(args?.limit, 'limit', 10, 1, 25);
      const tag_slug = args?.tag_slug ? requireNonEmpty(args.tag_slug, 'tag_slug') : undefined;
      const after_cursor = args?.next_cursor ? requireNonEmpty(args.next_cursor, 'next_cursor') : undefined;
      const response = await fetchTrendingEvents({ limit, tag_slug, after_cursor });
      const events = (response.events ?? []).map(eventRow);
      const references = (response.events ?? []).map(eventReference);
      if (!references.length) references.push(fallbackReference('polymarket-trending-empty', 'Polymarket trending events response', `${GAMMA_BASE_URL}/events/keyset`, response));
      return {
        text: events.length
          ? `Polymarket events trending by 24-hour volume:\n${events.map((event, index) => `${index + 1}. ${event.title} (${event.volume_24h} in 24h)${event.featured_market ? ` — ${event.featured_market}: ${event.top_outcome} ${event.top_probability} [market slug: ${event.featured_market_slug}]` : ''} [event slug: ${event.slug}]`).join('\n')}\n\n${probabilityNote}`
          : `No open Polymarket events were returned${tag_slug ? ` for tag ${tag_slug}` : ''}.`,
        data: { title: tag_slug ? `Trending Polymarket events — ${tag_slug}` : 'Trending Polymarket events', probability_note: probabilityNote, count: events.length, total_results: events.length, has_more: Boolean(response.next_cursor), next_cursor: response.next_cursor ?? '', tag_slug: tag_slug ?? '', events, raw: response },
        references,
      };
    },
  },

  polymarket_search: {
    description: 'Search active Polymarket events and their nested markets with Gamma /public-search. Returns event and market slugs for polymarket_get_event and polymarket_get_market plus a current probability preview. Closed markets, tag-only hits, and profiles are excluded. Defaults to 5 results per type on page 1; page is one-based and the response reports whether more results exist. Search ranking comes from Polymarket rather than 24-hour volume.',
    parameters: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: 'Natural search terms, for example “UK election”, “bitcoin”, or “Clarity Act”. This is full-text search, not an exact slug.' },
      limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum results per returned type. Defaults to 5; capped at 20 by this tool.' },
      page: { type: 'integer', minimum: 1, description: 'One-based search result page. Defaults to 1; increase while has_more is true.' },
    } },
    card: eventListCard,
    async execute(args) {
      const query = requireNonEmpty(args?.query, 'query');
      const limit = boundedInt(args?.limit, 'limit', 5, 1, 20);
      const page = boundedInt(args?.page, 'page', 1, 1, 10000);
      const response = await searchPolymarket({ q: query, limit_per_type: limit, page });
      const sourceEvents = response.events ?? [];
      const events = sourceEvents.map(eventRow);
      const references = sourceEvents.map(eventReference);
      if (!references.length) references.push(fallbackReference(`polymarket-search-${query}`, `Polymarket search: ${query}`, `${GAMMA_BASE_URL}/public-search?q=${encodeURIComponent(query)}`, response));
      return {
        text: events.length
          ? `Active Polymarket results for “${query}”:\n${events.map((event) => `${event.title} [event slug: ${event.slug}]${event.featured_market ? ` — ${event.featured_market}: ${event.top_outcome} ${event.top_probability} [market slug: ${event.featured_market_slug}]` : ''}`).join('\n')}\n\n${probabilityNote}`
          : `No active Polymarket events matched “${query}”.`,
        data: { title: `Polymarket search — ${query}`, probability_note: probabilityNote, query, page, count: events.length, total_results: response.pagination?.totalResults ?? events.length, has_more: Boolean(response.pagination?.hasMore), events, raw: response },
        references,
      };
    },
  },

  polymarket_get_event: {
    description: 'Retrieve one Polymarket event by exact event slug using Gamma /events/slug/:slug. Returns the event description, dates, tags, volume/liquidity, and every nested market with aligned outcomePrices interpreted as market-implied probabilities. Text summarizes at most 20 markets, while the result card retains the complete fetched market list. Use an event slug from polymarket_search or polymarket_trending_events; use polymarket_get_market with a market slug for bid/ask, last trade, CLOB token IDs, and full market resolution wording.',
    parameters: { type: 'object', required: ['slug'], properties: {
      slug: { type: 'string', description: 'Exact event slug returned by a Polymarket list/search tool, for example clarity-act-signed-into-law-in-2026. Do not pass a full URL or a market ID.' },
    } },
    card: { name: { singular: 'market', plural: 'markets' }, title: '{{title}}', layout: [
      { component: 'Columns', gap: 'md', columns: [
        { width: 3, layout: [
          { component: 'Text', text: '{{description}}' },
          { component: 'MetricRow', items: [{ label: '24h volume', field: 'volume_24h' }, { label: 'Total volume', field: 'total_volume' }, { label: 'Liquidity', field: 'liquidity' }] },
          { component: 'KeyValue', pairs: [{ label: 'Event ID', field: 'id' }, { label: 'Ends', field: 'end_date' }, { label: 'Tags', field: 'tags' }, { label: 'Status', field: 'status' }] },
        ] },
        { width: 1, layout: [{ component: 'Image', field: 'image', alt: 'Polymarket event image', variant: 'media', fit: 'contain', aspectRatio: '1/1' }] },
      ] },
      { component: 'Text', text: '{{probability_note}}' },
      { component: 'Table', rows: 'markets', columns: [{ header: 'Market', field: 'question' }, { header: 'Implied outcomes', field: 'outcomes' }, { header: '24h volume', field: 'volume_24h' }, { header: 'Liquidity', field: 'liquidity' }, { header: 'Ends', field: 'end_date' }, { header: 'Market slug', field: 'market_slug' }] },
    ] },
    async execute(args) {
      const slug = requireNonEmpty(args?.slug, 'slug');
      const event = await fetchEventBySlug(slug);
      if (!event?.id) throw new Error(`Polymarket event “${slug}” was not returned by the API.`);
      const markets = (event.markets ?? []).map(marketRow);
      const visible = markets.slice(0, 20);
      return {
        text: `${event.title ?? slug}\n${visible.length ? visible.map((market) => `${market.question}: ${market.outcomes} [market slug: ${market.market_slug}]`).join('\n') : 'No markets were returned for this event.'}${markets.length > visible.length ? `\n${markets.length - visible.length} additional markets are retained in the result card.` : ''}\n\n${probabilityNote}`,
        data: { id: event.id, slug: event.slug ?? slug, title: event.title ?? slug, description: event.description ?? '', image: event.image ?? event.icon ?? '', volume_24h: usd(event.volume24hr), total_volume: usd(event.volume), liquidity: usd(event.liquidity), end_date: event.endDate ?? '', tags: (event.tags ?? []).map((tag) => tag.label ?? tag.slug ?? '').filter(Boolean).join(', '), status: event.closed ? 'Closed' : event.active ? 'Active' : 'Inactive', probability_note: probabilityNote, count: markets.length, markets, raw: event },
        references: [eventReference(event)],
      };
    },
  },

  polymarket_get_market: {
    description: 'Retrieve one Polymarket market by exact market slug using Gamma /markets/slug/:slug. Returns every outcome aligned with its current outcomePrice and CLOB token ID, plus bid, ask, spread, last trade, one-day price change, volume, liquidity, status, deadline, description, and raw payload. A contract price of 0.185 is shown as an 18.5% market-implied probability; it is not a factual probability or guarantee. Use a market slug returned inside polymarket_get_event or polymarket_search. For an uncached public order-book midpoint, pass the desired outcome’s token_id to polymarket_get_live_midpoint.',
    parameters: { type: 'object', required: ['slug'], properties: {
      slug: { type: 'string', description: 'Exact market slug returned by an event/search result. Do not pass an event slug unless that event and its sole market share the same slug.' },
    } },
    card: { name: { singular: 'outcome', plural: 'outcomes' }, title: '{{question}}', layout: [
      { component: 'Columns', gap: 'md', columns: [
        { width: 3, layout: [
          { component: 'Text', text: '{{description}}' },
          { component: 'MetricRow', items: [{ label: '24h volume', field: 'volume_24h' }, { label: 'Total volume', field: 'total_volume' }, { label: 'Liquidity', field: 'liquidity' }, { label: '1d points', field: 'one_day_change', tone: 'delta' }] },
          { component: 'KeyValue', pairs: [{ label: 'Best bid', field: 'best_bid' }, { label: 'Best ask', field: 'best_ask' }, { label: 'Last trade', field: 'last_trade' }, { label: 'Spread', field: 'spread' }, { label: 'Ends', field: 'end_date' }, { label: 'Status', field: 'status' }] },
        ] },
        { width: 1, layout: [{ component: 'Image', field: 'image', alt: 'Polymarket market image', variant: 'media', fit: 'contain', aspectRatio: '1/1' }] },
      ] },
      { component: 'Text', text: '{{probability_note}}' },
      { component: 'Table', rows: 'outcomes', columns: [{ header: 'Outcome', field: 'outcome' }, { header: 'Implied probability', field: 'probability' }, { header: 'Raw price', field: 'price' }, { header: 'CLOB token ID', field: 'token_id' }] },
    ] },
    async execute(args) {
      const slug = requireNonEmpty(args?.slug, 'slug');
      const market = await fetchMarketBySlug(slug);
      if (!market?.id) throw new Error(`Polymarket market “${slug}” was not returned by the API.`);
      const outcomes = outcomeRows(market);
      const sourceUrl = `${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`;
      return {
        text: `${market.question ?? slug}\n${outcomes.length ? outcomes.map((row) => `${row.outcome}: ${row.probability || 'unpriced'}${row.token_id ? ` (token ${row.token_id})` : ''}`).join('\n') : 'No outcome prices were returned.'}\n\nThese are market-implied probabilities, not factual forecasts or guarantees.`,
        data: { id: market.id, slug: market.slug ?? slug, question: market.question ?? slug, description: market.description ?? '', image: market.image ?? market.icon ?? '', probability_note: probabilityNote, count: outcomes.length, outcomes, volume_24h: usd(market.volume24hr), total_volume: usd(market.volumeNum ?? market.volume), liquidity: usd(market.liquidityNum ?? market.liquidity), one_day_change: optionalNumber(market.oneDayPriceChange) === undefined ? 0 : Number((numberValue(market.oneDayPriceChange) * 100).toFixed(2)), best_bid: percent(market.bestBid), best_ask: percent(market.bestAsk), last_trade: percent(market.lastTradePrice), spread: percent(market.spread), end_date: market.endDate ?? '', status: market.closed ? 'Closed' : market.acceptingOrders ? 'Trading' : market.active ? 'Active' : 'Inactive', raw: market },
        references: [createApiReference({ id: `polymarket-market-${market.id}`, label: market.question ?? slug, sourceUrl, quote: `${market.question ?? slug}: ${outcomes.map((row) => `${row.outcome} ${row.probability}`).join(', ')}`, payload: market })],
      };
    },
  },

  polymarket_get_live_midpoint: {
    description: 'Fetch the current public CLOB order-book midpoint for one Polymarket outcome token using GET /midpoint. The midpoint is the average of the current best bid and ask and is returned as a 0-1 contract price plus percentage. Use polymarket_get_market first to obtain the CLOB token ID for the exact outcome. The endpoint needs no credential; invalid tokens or markets without an order book return an API error. This plugin disables host response caching so this call reaches the public API each time.',
    parameters: { type: 'object', required: ['token_id'], properties: {
      token_id: { type: 'string', description: 'Exact large decimal CLOB token ID for one outcome, copied from polymarket_get_market. This is not the Gamma market ID, condition ID, slug, or outcome label.' },
    } },
    card: { name: { singular: 'midpoint', plural: 'midpoints' }, title: 'Polymarket live midpoint', layout: [
      { component: 'MetricRow', items: [{ label: 'Implied probability', field: 'probability' }, { label: 'Raw midpoint', field: 'midpoint' }] },
      { component: 'KeyValue', pairs: [{ label: 'CLOB token ID', field: 'token_id' }, { label: 'Meaning', field: 'note' }] },
    ] },
    async execute(args) {
      const token_id = requireNonEmpty(args?.token_id, 'token_id');
      const response = await fetchMidpoint(token_id);
      const midpoint = response.mid ?? response.mid_price;
      if (midpoint === undefined || !Number.isFinite(Number(midpoint))) throw new Error(`Polymarket returned no valid midpoint for token ${token_id}.`);
      const sourceUrl = `${CLOB_BASE_URL}/midpoint?token_id=${encodeURIComponent(token_id)}`;
      return {
        text: `Polymarket token ${token_id} midpoint: ${midpoint}, or ${percent(midpoint)} market-implied probability. ${probabilityNote}`,
        data: { token_id, midpoint: String(midpoint), probability: percent(midpoint), note: probabilityNote, raw: response },
        references: [createApiReference({ id: `polymarket-midpoint-${token_id}`, label: `Polymarket midpoint ${percent(midpoint)}`, sourceUrl, quote: `Midpoint ${midpoint} (${percent(midpoint)})`, payload: response })],
      };
    },
  },
});
