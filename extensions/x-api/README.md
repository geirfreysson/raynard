# X API

Raynard Explore-mode plugin for public X (Twitter) data exposed by the official X API. The plugin uses the host-supplied `@raynard/plugin-sdk` for HTTP, credentials, cards, and citations.

## Authentication

This plugin requires a credential declared as `X_API_BEARER_TOKEN`.

- Label: X API bearer token / API key
- Sign-up / developer portal: https://developer.x.com/en/portal/dashboard
- Notes: endpoint availability, recent-search window, rate limits, and fields can vary by X API access tier.

## Implemented Tools

- `x_search_recent_posts` — searches `GET /2/tweets/search/recent` with recent-search query syntax, optional `max_results`, `next_token`, `start_time`, and `end_time`. Returns post rows, author expansion, public metrics, conversation IDs, pagination token, raw response, and X status citations.
- `x_get_conversation_posts` — searches recent posts with `conversation_id:<id>` to inspect visible conversation/thread posts and public engagement metadata.
- `x_get_post` — retrieves `GET /2/tweets/:id` for one public post with public metrics, author expansion, references, conversation metadata, raw response, and X status citation.
- `x_get_user_by_username` — retrieves `GET /2/users/by/username/:username` with public profile fields and public account metrics. Use this to find the numeric user ID for timeline calls.
- `x_get_user_posts` — lists `GET /2/users/:id/tweets` for a numeric user ID with pagination, optional time bounds, and optional reply/retweet exclusions.
- `x_get_trends_by_location` — retrieves the current ordered trends for a geographic location through `GET /2/trends/by/woeid/:woeid`, with an optional 1-50 result limit, post volumes where X supplies them, and links to the live X searches.

## Endpoint Inventory

| Endpoint | Status | Parameters and response shape | Tool or future tool |
| --- | --- | --- | --- |
| `GET /2/tweets/search/recent` | Implemented | Required `query`; optional `max_results` 10-100, `next_token`, `start_time`, `end_time`, `tweet.fields`, `expansions`, `user.fields`. Response includes `data[]` tweets, `includes.users[]`, `meta.result_count`, IDs, and `meta.next_token` when more results are available. Rate limits and recent window depend on X API tier. | `x_search_recent_posts`; `x_get_conversation_posts` uses `conversation_id:<id>` |
| `GET /2/tweets/:id` | Implemented | Path `id`; optional field/expansion parameters. Response includes one `data` tweet plus `includes` and possible `errors`. | `x_get_post` |
| `GET /2/users/by/username/:username` | Implemented | Path `username`; optional `user.fields`. Response includes one public user object and possible `errors`. | `x_get_user_by_username` |
| `GET /2/users/:id/tweets` | Implemented | Path numeric user `id`; optional `max_results` 5-100, `pagination_token`, `start_time`, `end_time`, `exclude`, fields and expansions. Response includes `data[]` tweets, `includes.users[]`, and `meta.next_token`. | `x_get_user_posts` |
| `GET /2/trends/by/woeid/:woeid` | Implemented | Path positive 32-bit Yahoo WOEID; optional `max_trends` 1-50 (default 20) and `trend.fields`. Response is an ordered `data[]` of `trend_name` with optional `tweet_count`; app-only rate limit is 75 requests per 15 minutes. Common official IDs include Worldwide `1`, United States `23424977`, United Kingdom `23424975`, Japan `23424856`, New York `2459115`, Los Angeles `2442047`, London `44418`, and Tokyo `1118370`. | `x_get_trends_by_location` |
| `GET /2/users/personalized_trends` | Planned | Requires OAuth 2.0 user context and a Premium User Subscription; optional `personalized_trend.fields`. Response contains personalized `trend_name`, `category`, `post_count`, and `trending_since`. Per-user limits differ from app-only trends. | Future `x_get_personalized_trends` after user-context OAuth support |
| `GET /2/users/:id` | Planned | Path numeric user `id`; optional `user.fields`. Same user response shape as username lookup. | Future `x_get_user_by_id` |
| `GET /2/users` | Planned | Batch lookup by comma-separated user IDs; optional `user.fields`. Response includes `data[]` users and possible `errors`. | Future `x_get_users_by_ids` |
| `GET /2/users/by` | Planned | Batch lookup by comma-separated usernames; optional `user.fields`. Response includes `data[]` users and possible `errors`. | Future `x_get_users_by_usernames` |
| `GET /2/tweets` | Planned | Batch lookup by comma-separated tweet IDs; optional `tweet.fields`, `expansions`, `user.fields`. Response includes `data[]` tweets, `includes`, and `errors`. | Future `x_get_posts_by_ids` |
| `GET /2/users/:id/mentions` | Planned | User mention timeline; optional pagination/time fields similar to user tweets. Response is paginated tweet list. | Future `x_get_user_mentions` |
| `GET /2/tweets/:id/retweeted_by` | Planned | Path tweet ID; optional pagination and `user.fields`. Response is paginated users who retweeted. | Future `x_get_post_retweeted_by` |
| `GET /2/tweets/:id/liking_users` | Planned | Path tweet ID; optional pagination and `user.fields`. Response is paginated users who liked, where permitted. | Future `x_get_post_liking_users` |
| `GET /2/users/:id/followers` | Planned | Path user ID; optional pagination and `user.fields`. Response is paginated public users. | Future `x_get_user_followers` |
| `GET /2/users/:id/following` | Planned | Path user ID; optional pagination and `user.fields`. Response is paginated public users. | Future `x_get_user_following` |
| Filtered stream, sampled stream, compliance, write, DM, ads, OAuth management endpoints | Not applicable | Streaming, write/admin, direct message, advertising, compliance, or account-management workflows are outside this read-only Explore-mode public-data plugin. | Not planned |

## Source documentation

- https://docs.x.com/x-api/overview
- https://docs.x.com/x-api/trends/trends-by-woeid/introduction
- https://docs.x.com/x-api/trends/get-trends-by-woeid
- https://docs.x.com/x-api/fundamentals/rate-limits

## Live probing notes

Before implementation, the documented X API host was probed with `curl` for recent search, tweet lookup, username lookup, user timeline, and trends-by-WOEID paths. Without a bearer token, each returned HTTP 401 with `content-type: application/problem+json` and body `{"title":"Unauthorized","type":"about:blank","status":401,"detail":"Unauthorized"}`. The plugin therefore declares a runtime credential and does not load or store secrets in the workspace.
