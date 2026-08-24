import { apiGet } from '@raynard/plugin-sdk';

export const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';
export const CLOB_BASE_URL = 'https://clob.polymarket.com';

export type GammaTag = {
  id?: string;
  label?: string;
  slug?: string;
};

export type GammaEventLink = {
  id?: string;
  slug?: string;
  title?: string;
};

export type GammaMarket = {
  id: string;
  slug?: string;
  question?: string;
  description?: string;
  resolutionSource?: string;
  outcomes?: string | string[] | null;
  outcomePrices?: string | string[] | null;
  clobTokenIds?: string | string[] | null;
  image?: string;
  icon?: string;
  active?: boolean;
  closed?: boolean;
  acceptingOrders?: boolean;
  endDate?: string;
  volume?: string | number;
  volumeNum?: number;
  volume24hr?: number;
  liquidity?: string | number;
  liquidityNum?: number;
  lastTradePrice?: number;
  bestBid?: number;
  bestAsk?: number;
  spread?: number;
  oneDayPriceChange?: number;
  events?: GammaEventLink[];
  [key: string]: unknown;
};

export type GammaEvent = {
  id: string;
  slug?: string;
  title?: string;
  subtitle?: string;
  description?: string;
  resolutionSource?: string;
  image?: string;
  icon?: string;
  active?: boolean;
  closed?: boolean;
  endDate?: string;
  volume?: number;
  volume24hr?: number;
  liquidity?: number;
  markets?: GammaMarket[];
  tags?: GammaTag[];
  [key: string]: unknown;
};

export type EventsKeysetResponse = {
  events: GammaEvent[];
  next_cursor?: string;
};

export type SearchResponse = {
  events?: GammaEvent[] | null;
  tags?: GammaTag[] | null;
  profiles?: unknown[] | null;
  pagination?: { hasMore?: boolean; totalResults?: number };
};

export type MidpointResponse = {
  mid?: string;
  mid_price?: string;
};

export function fetchTrendingEvents(args: {
  limit: number;
  after_cursor?: string;
  tag_slug?: string;
}): Promise<EventsKeysetResponse> {
  return apiGet<EventsKeysetResponse>(`${GAMMA_BASE_URL}/events/keyset`, {
    query: {
      limit: args.limit,
      order: 'volume24hr',
      ascending: false,
      closed: false,
      after_cursor: args.after_cursor,
      tag_slug: args.tag_slug,
    },
    label: 'Polymarket trending events',
  });
}

export function searchPolymarket(args: {
  q: string;
  limit_per_type: number;
  page: number;
}): Promise<SearchResponse> {
  return apiGet<SearchResponse>(`${GAMMA_BASE_URL}/public-search`, {
    query: {
      q: args.q,
      limit_per_type: args.limit_per_type,
      page: args.page,
      events_status: 'active',
      keep_closed_markets: 0,
      search_tags: false,
      search_profiles: false,
    },
    label: 'Polymarket public search',
  });
}

export function fetchEventBySlug(slug: string): Promise<GammaEvent> {
  return apiGet<GammaEvent>(`${GAMMA_BASE_URL}/events/slug/${encodeURIComponent(slug)}`, {
    label: 'Polymarket event detail',
  });
}

export function fetchMarketBySlug(slug: string): Promise<GammaMarket> {
  return apiGet<GammaMarket>(`${GAMMA_BASE_URL}/markets/slug/${encodeURIComponent(slug)}`, {
    label: 'Polymarket market detail',
  });
}

export function fetchMidpoint(tokenId: string): Promise<MidpointResponse> {
  return apiGet<MidpointResponse>(`${CLOB_BASE_URL}/midpoint`, {
    query: { token_id: tokenId },
    label: 'Polymarket CLOB midpoint',
  });
}
