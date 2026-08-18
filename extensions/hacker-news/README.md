# Hacker News

Query the official Hacker News API (https://github.com/hackernews/api) to fetch stories, comments, users, and metadata: top/new/best/ask/show/job story feeds, item details (story/comment/job/poll/pollopt), user profiles, the max-item heartbeat, and the live-updates feed. Story filtering by keyword, item type, and time period is provided client-side by `hn_search_stories` (the official API has no server-side search or filtering).

## Implemented Tools

### List / search tools

| Tool | What it answers |
| --- | --- |
| `hn_list_top_stories` | Current front-page ranking (`/v0/topstories.json`). Optional `limit` (1-30, default 10). |
| `hn_list_new_stories` | Freshest submissions (`/v0/newstories.json`). Optional `limit`. |
| `hn_list_best_stories` | Highest-voted recent stories (`/v0/beststories.json`). Optional `limit`. |
| `hn_list_ask_stories` | Latest Ask HN posts (`/v0/askstories.json`). Optional `limit`. |
| `hn_list_show_stories` | Latest Show HN posts (`/v0/showstories.json`). Optional `limit`. |
| `hn_list_job_stories` | Latest job postings (`/v0/jobstories.json`). Optional `limit`. |
| `hn_search_stories` | Scans a feed (`top`/`new`/`best`/`ask`/`show`/`job`, default `new`) and filters client-side by `query` keyword, `type` (story/job/poll), `period` (hour/day/week/month) and explicit `minTime`/`maxTime` Unix-second windows. `limit` (1-30, default 10) and `scanLimit` (10-500, default 100) control depth. |

### Detail and metadata tools

| Tool | What it answers | Card contents |
| --- | --- | --- |
| `hn_get_item` | Full detail for one item id (story, comment, job, poll, pollopt) from `/v0/item/<id>.json`. | Type badge, score/comment metrics, author/posted/link/id, text snippet. |
| `hn_get_item_comments` | Top-level discussion for an item id (`/v0/item/<id>.json` + each `kids` entry). Optional `limit` (1-30, default 10). | Total/shown metrics, table of comment author + plain-text body. |
| `hn_get_user` | Profile for an exact case-sensitive username from `/v0/user/<username>.json`. | Karma/submission metrics, creation date, about text. |
| `hn_get_max_item` | Activity heartbeat: current largest item id from `/v0/maxitem.json`. | Max item id metric. |
| `hn_get_live_updates` | Recently changed items and profiles from `/v0/updates.json`. | Changed-count metrics + raw id lists. |

Every tool returns concise text plus `createApiReference()` citations carrying the raw API payload and the `hacker-news.firebaseio.com` source URL, so Explore-mode answers can quote and cite the underlying data.

## Endpoint Inventory

All endpoints are unauthenticated `GET` JSON under `https://hacker-news.firebaseio.com/v0`. The official API has no documented rate limit and no pagination parameters — feeds return at most 500 ids (top/new/best) or 200 ids (ask/show/job), and clients page by slicing the id array and fetching items individually.

| Endpoint | Purpose | Parameters | Response shape | Status | Tool |
| --- | --- | --- | --- | --- | --- |
| `GET /v0/topstories.json` | Up to 500 current top story ids | none | `number[]` | Implemented | `hn_list_top_stories` (list), `hn_search_stories` |
| `GET /v0/newstories.json` | Up to 500 newest story ids | none | `number[]` | Implemented | `hn_list_new_stories` (list), `hn_search_stories` |
| `GET /v0/beststories.json` | Up to 500 highest-voted recent story ids | none | `number[]` | Implemented | `hn_list_best_stories` (list), `hn_search_stories` |
| `GET /v0/askstories.json` | Up to 200 latest Ask HN story ids | none | `number[]` | Implemented | `hn_list_ask_stories` (list), `hn_search_stories` |
| `GET /v0/showstories.json` | Up to 200 latest Show HN story ids | none | `number[]` | Implemented | `hn_list_show_stories` (list), `hn_search_stories` |
| `GET /v0/jobstories.json` | Up to 200 latest job posting ids | none | `number[]` | Implemented | `hn_list_job_stories` (list), `hn_search_stories` |
| `GET /v0/item/<id>.json` | One story, comment, job, poll or pollopt | path: `id` (integer, required) | `{ id, deleted?, type, by?, time?, text?, dead?, parent?, poll?, kids?, url?, score?, title?, parts?, descendants? }` or `null` | Implemented | `hn_get_item` (card), `hn_get_item_comments` (card) |
| `GET /v0/user/<username>.json` | One user profile | path: `username` (case-sensitive string, required) | `{ id, created?, karma?, about?, submitted? }` or `null` | Implemented | `hn_get_user` (card) |
| `GET /v0/maxitem.json` | Current largest item id (activity heartbeat) | none | `number` | Implemented | `hn_get_max_item` (card) |
| `GET /v0/updates.json` | Recently changed items and profiles | none | `{ items: number[], profiles: string[] }` | Implemented | `hn_get_live_updates` (card) |

### Future / out-of-scope endpoints

| Endpoint | Purpose | Parameters | Response shape | Pagination / rate limits | Status | Proposed future tool |
| --- | --- | --- | --- | --- | --- | --- |
| `GET https://hn.algolia.com/api/v1/search?query=…` (Algolia HN Search) | True full-text search over all HN stories/comments, with server-side time-period and tag filters | optional: `query`, `tags` (story/comment/ask_hn/show_hn/job/poll), `numericFilters` (e.g. `created_at_i>…`), `page`, `hitsPerPage` | `{ hits: [{ objectID, title, url, author, points, num_comments, created_at_i, … }], nbPages, page, … }` | Paginated via `page`/`hitsPerPage`; Algolia rate limits apply | Not applicable — a separate third-party API, not part of the official API surface documented at https://github.com/hackernews/api | `hn_full_text_search` (server-side relevance + date-range search, complementing the client-side `hn_search_stories`) |

## Source Documentation

- https://github.com/hackernews/api (official Hacker News API v0)

## Build Contract

Build TypeScript API tooling for Raynard explore mode. Do not build React, routes, pages, CSS, or a standalone visual explorer. The chat UI already exists; this plugin exists so the agent can call API tools and talk to returned data.

## API Surface Contract

Treat the source API documentation as a whole API surface, not only the latest narrow user query. Build a practical suite of small, focused tools for important endpoints/resources such as list/search, detail-by-id, user/profile/account, metadata/status, and update/history endpoints when available. If only a subset is implemented, keep an `Endpoint Inventory` in this README that records each relevant endpoint path, purpose, required and optional parameters, response shape summary, pagination/rate-limit notes, status (`Implemented`, `Planned`, or `Not applicable`), and the future tool that should expose it.

## Tool Description Contract

Every exported tool must include a specific `description` and JSON `parameters` schema. Explore mode injects generated tool names, descriptions, and schemas into the prompt so the agent can choose the right tool across plugins. Avoid vague descriptions; state what user questions the tool answers, what API data it fetches, required arguments, useful optional arguments, and important limits or follow-up tools.

## Explore-Mode Contract

API tools should return concise text plus structured references with `referenceId`, `referenceLabel`, `referenceMeta`, and expanded raw payload content. Assistant answers should cite the returned references when discussing API data.

## Result Card Contract

Every tool declares a fixed `card` template and returns a matching `data` object; the host renders one card beneath the assistant message for every API call. List/search tools use bounded table or summary cards. The card layout is fixed at build time and never varies per call — only the `data` it binds to changes.

## Testing

All tests use mocked fetch (no network) and run with the Node built-in test runner:

```
node --test
```

- `client.test.ts` — every fetch helper in `client.ts`, URL correctness, null/deleted handling, HTTP error surfacing.
- `tools.test.ts` — every tool in the registry asserts its rendered text, card-bound `data` fields, and validation/error paths.
