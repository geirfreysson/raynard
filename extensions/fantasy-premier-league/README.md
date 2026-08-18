# Fantasy Premier League

Raynard Explore-mode tools for the official (undocumented) Fantasy Premier League API at
`https://fantasy.premierleague.com/api`. The API is read-only and unauthenticated for the
endpoints used here; no keys or secrets are stored.

## Implemented tools

| Tool | Answers | Endpoint(s) | Card? |
| --- | --- | --- | --- |
| `fpl_get_game_overview` | How many players/teams are in the game, which gameweek is current/next, deadlines and last-GW average scores | `GET /bootstrap-static/` | Yes — season snapshot |
| `fpl_search_players` | Which players match a name/team/position filter, with prices, form and points; returns ids for follow-up | `GET /bootstrap-static/` | Yes — player search table |
| `fpl_get_player` | Full player profile: season stats, xG/xA, price, ownership, upcoming fixtures with FDR, recent gameweeks, past seasons | `GET /bootstrap-static/`, `GET /element-summary/{player_id}/` | Yes — player card |
| `fpl_list_fixtures` | Fixtures for a gameweek or the whole season, scores, kickoffs, optional team filter | `GET /fixtures/`, `GET /fixtures/?event={gw}` | Yes — fixture table |
| `fpl_get_entry` | A manager's team name, overall points/rank, GW points, squad value, bank, leagues | `GET /entry/{team_id}/` | Yes — team card |
| `fpl_get_entry_history` | A manager's gameweek-by-gameweek points/rank/value, chips played, past-season finishes | `GET /entry/{team_id}/history/` | Yes — season history card |
| `fpl_get_entry_picks` | A manager's squad for one gameweek: XI, bench, captain, chip, points, transfer cost | `GET /entry/{team_id}/event/{gw}/picks/` + `/bootstrap-static/` (name resolution) | Yes — squad card |
| `fpl_get_league_standings` | Classic mini-league table with ranks, managers, GW and total points (50 per page) | `GET /leagues-classic/{league_id}/standings/?page_standings={n}` | Yes — league table card |

Every tool returns concise text plus `createApiReference` citations carrying the source URL
and raw payload so answers can be quoted and verified in Explore mode. Every tool also
declares a fixed result card and returns matching structured card data, including searches
and fixture lists.

## Endpoint Inventory

Source docs: <https://www.postman.com/fplassist/fpl-assist/collection/zqlmv01/fantasy-premier-league-api>

| Endpoint | Purpose | Params | Response shape | Pagination / limits | Status | Tool |
| --- | --- | --- | --- | --- | --- | --- |
| `GET /bootstrap-static/` | Game-wide data: all players (`elements`), teams, gameweeks (`events`), positions (`element_types`) | none | `{ elements, teams, events, element_types, ... }` | Single payload (~all players); cache-friendly | Implemented | `fpl_get_game_overview`, `fpl_search_players`, `fpl_get_player`, `fpl_get_entry_picks` |
| `GET /element-summary/{player_id}/` | Per-player detail: remaining `fixtures`, this-season per-GW `history`, `history_past` seasons | path: `player_id` | `{ fixtures[], history[], history_past[] }` | One call per player | Implemented | `fpl_get_player` |
| `GET /fixtures/` | Every fixture in the season with scores, kickoffs, difficulty | optional query: `event` | `Fixture[]` | 380 rows max; filter server-side with `?event=` | Implemented | `fpl_list_fixtures` |
| `GET /fixtures/?event={gw}` | Fixtures for one gameweek | query: `event` (1–38) | `Fixture[]` | 10 rows per GW | Implemented | `fpl_list_fixtures` |
| `GET /entry/{team_id}/` | Manager/team overview: points, ranks, value, leagues | path: `team_id` | `{ id, name, player_first_name, summary_overall_points, summary_overall_rank, leagues, ... }` | One call per entry | Implemented | `fpl_get_entry` |
| `GET /entry/{team_id}/history/` | Per-GW season history, past seasons, chips played | path: `team_id` | `{ current[], past[], chips[] }` | One call per entry | Implemented | `fpl_get_entry_history` |
| `GET /entry/{team_id}/event/{gw}/picks/` | Squad picked for a gameweek with captain, chip, GW score | path: `team_id`, `gw` | `{ picks[], active_chip, entry_history, automatic_subs[] }` | One call per entry+GW | Implemented | `fpl_get_entry_picks` |
| `GET /leagues-classic/{league_id}/standings/` | Classic league table | path: `league_id`; query: `page_standings`, `phase`, `page_new_entries` | `{ league, standings: { has_next, page, results[] } }` | 50 entries per page; use `page_standings` | Implemented | `fpl_get_league_standings` |
| `GET /entry/{team_id}/transfers/` | A manager's full transfer history (player in/out, cost, GW) | path: `team_id` | `Transfer[]` | One call per entry | Planned | future `fpl_get_entry_transfers` |
| `GET /leagues-h2h/{league_id}/standings/` | Head-to-head league table | path: `league_id`; query: `page_standings` | `{ league, standings: { results[] } }` | Paginated like classic | Planned | future `fpl_get_h2h_standings` |
| `GET /leagues-h2h-matches/league/{league_id}/` | H2H matchup results per gameweek | path: `league_id`; query: `event`, `page` | `{ results[] }` | Paginated | Planned | future `fpl_get_h2h_matches` |
| `GET /dream-team/{gw}/` | Official dream team XI for a gameweek | path: `gw` | `{ top_player, team[] }` | One call per GW | Planned | future `fpl_get_dream_team` |
| `GET /event/{gw}/live/` | Live per-player points during a gameweek | path: `gw` | `{ elements[] }` | Large; only meaningful mid-GW | Planned | future `fpl_get_live_gameweek` |
| `GET /team/set-piece-notes/`, `GET /game-settings/` | Static metadata (set-piece takers, game rules) | none | object/array | Rarely changes | Not applicable | Low user value for Explore answers |
| `GET /my-team/{team_id}/`, `POST /transfers/`, auth endpoints | Authenticated team management | credentials | — | Requires login cookies | Not applicable | Read-only plugin; no secrets stored |

## Notes

- Player prices are returned by the API as tenths of £1m (128 = £12.8m); tools format them.
- Chips are returned as codes (`wildcard`, `freehit`, `bboost`, `3xc`) and rendered as labels.
- Rate limits are unofficial; tools make at most two API calls per invocation.
