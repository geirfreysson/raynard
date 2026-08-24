# Polymarket

Read-only Raynard Explore extension for public Polymarket Predictions data. It uses the host-supplied `@raynard/plugin-sdk` and the unauthenticated Gamma and CLOB APIs.

## Authentication

No credential is required for the implemented public discovery, metadata, and midpoint endpoints. Trading, private positions, and account actions are intentionally outside this extension.

## Implemented Tools

- `polymarket_trending_events` — lists open events from the current keyset endpoint, ranked by descending `volume24hr`, with event/market slugs and a featured market probability preview.
- `polymarket_search` — searches active events and nested markets with `/public-search`, excluding closed markets, profiles, and tag-only results.
- `polymarket_get_event` — returns one event by slug with its description, tags, dates, activity metrics, and every nested market's aligned outcome prices.
- `polymarket_get_market` — returns one market by slug with all outcome prices and CLOB token IDs, bid/ask, last trade, spread, change, volume, liquidity, and resolution wording.
- `polymarket_get_live_midpoint` — returns the current public CLOB midpoint for one outcome token ID.

Contract prices are presented as **market-implied probabilities**, not objective probabilities, factual predictions, investment advice, or guarantees. The installed extension's host cache is disabled so “current” price and midpoint requests reach the public API on each call.

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Tool or future tool |
| --- | --- | --- | --- |
| `GET https://gamma-api.polymarket.com/events/keyset` | Implemented | Cursor-paginated event list. This extension sends `closed=false`, `order=volume24hr`, `ascending=false`; supports `limit` 1-25, `after_cursor`, and `tag_slug`. Response has `events[]` with nested markets and optional `next_cursor`. The documented API maximum is 500, but the tool caps pages at 25. | `polymarket_trending_events` |
| `GET https://gamma-api.polymarket.com/public-search` | Implemented | Required `q`; this extension uses active events, excludes closed markets/profiles/tags, and supports `limit_per_type` plus one-based `page`. Response has `events[]` and `pagination.{hasMore,totalResults}`. | `polymarket_search` |
| `GET https://gamma-api.polymarket.com/events/slug/:slug` | Implemented | Exact event slug. Response contains event metadata, tags, activity fields, and nested `markets[]`; `outcomes`, `outcomePrices`, and `clobTokenIds` are observed as JSON-encoded array strings. | `polymarket_get_event` |
| `GET https://gamma-api.polymarket.com/markets/slug/:slug` | Implemented | Exact market slug. Response contains resolution wording, outcome prices/token IDs, bid/ask/trade/spread/change, volume, liquidity, status, and dates. | `polymarket_get_market` |
| `GET https://clob.polymarket.com/midpoint?token_id=...` | Implemented | Required CLOB outcome token ID. Documentation describes `mid_price`; the live API probe returned `{ "mid": "0.185" }`, so the client accepts both field names. | `polymarket_get_live_midpoint` |
| `GET /events` and `GET /markets` offset pagination | Not applicable | Live responses carry `Deprecation: true`, `Sunset: Fri, 01 May 2026`, and `Warning: 299 - "use /events/keyset"`; current keyset endpoints replace these for new list integrations. | Not used |
| `GET /markets/keyset` | Planned | Stable cursor-paginated market listing with `limit` 1-100, ordering, `after_cursor`, market/status/date/liquidity/volume filters, and no numeric offset. | Future `polymarket_list_markets` if direct market browsing is needed |
| `GET /book`, `/price`, `/spread`, `/last-trade-price`, `/prices-history` | Planned | Public CLOB order-book and price endpoints keyed by outcome token ID; history adds time interval/range controls. | Future focused order-book and history tools |
| `GET /tags` and related-tag endpoints | Planned | Public tag catalog, lookup, and relationships for discovering valid topic filters. | Future `polymarket_list_tags` / `polymarket_get_related_tags` |
| Data API public profiles, positions, trades, activity, leaderboard | Planned | Public wallet-address/account and market activity endpoints with endpoint-specific pagination and filters. | Future profile/activity tools if requested |
| Orders, cancellations, private positions, authenticated account actions, relayer, bridge, and WebSocket trading | Not applicable | These require credentials, signing, user context, persistent streams, or mutation and are outside this read-only research extension. | Not planned |

## Source Documentation

- https://docs.polymarket.com/api-reference/predictions/overview
- https://docs.polymarket.com/api-reference/events/list-events-keyset-pagination
- https://docs.polymarket.com/api-reference/search/search-markets-events-and-profiles
- https://docs.polymarket.com/api-reference/events/get-event-by-slug
- https://docs.polymarket.com/api-reference/markets/get-market-by-slug
- https://docs.polymarket.com/api-reference/data/get-midpoint-price
- https://docs.polymarket.com/api-reference/rate-limits

## Live Probe Notes

The public endpoints were called before implementation. The current keyset event list returned HTTP 200 with `events[]`, nested market objects, and `next_cursor`; sorting by `volume24hr` descending produced active high-volume events. Public search returned active event results and pagination. Event and market slug endpoints returned JSON-encoded `outcomes`, `outcomePrices`, and `clobTokenIds`. The CLOB midpoint endpoint returned HTTP 200 with a `mid` string. No key or secret was sent or stored.
