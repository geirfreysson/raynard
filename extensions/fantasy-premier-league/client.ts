// Thin fetch helpers for the official Fantasy Premier League API, one per
// documented endpoint. All helpers reuse the shared apiGet plumbing.
// Docs: https://www.postman.com/fplassist/fpl-assist/collection/zqlmv01/fantasy-premier-league-api
import { apiGet } from '@raynard/plugin-sdk';

export const BASE = 'https://fantasy.premierleague.com/api';

// --- Shared shapes ---------------------------------------------------------

export type FplElementType = {
  id: number;
  singular_name_short: string; // GKP | DEF | MID | FWD
  singular_name?: string;
};

export type FplTeam = {
  id: number;
  name: string;
  short_name: string;
  strength?: number;
  position?: number;
};

export type FplEvent = {
  id: number;
  name: string; // e.g. "Gameweek 5"
  deadline_time?: string;
  is_current: boolean;
  is_next: boolean;
  finished: boolean;
  average_entry_score?: number;
  highest_score?: number | null;
};

export type FplPlayer = {
  id: number;
  web_name: string;
  first_name: string;
  second_name: string;
  team: number;
  element_type: number;
  now_cost: number; // price x10, e.g. 128 => £12.8m
  total_points: number;
  points_per_game: string;
  form: string;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  minutes: number;
  selected_by_percent: string;
  status: string; // a = available, d = doubtful, i = injured, s = suspended, u = unavailable
  news: string;
  chance_of_playing_next_round: number | null;
  ict_index: string;
  expected_goals: string;
  expected_assists: string;
  transfers_in_event: number;
  transfers_out_event: number;
};

export type BootstrapStatic = {
  elements: FplPlayer[];
  teams: FplTeam[];
  events: FplEvent[];
  element_types: FplElementType[];
};

export type PlayerUpcomingFixture = {
  id: number;
  event: number;
  team_h: number;
  team_a: number;
  kickoff_time: string | null;
  is_home: boolean;
  difficulty: number;
  team_h_difficulty?: number;
  team_a_difficulty?: number;
};

export type PlayerSeasonGameweek = {
  element: number;
  round: number;
  total_points: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
  bonus: number;
  value: number;
  opponent_team: number;
  was_home: boolean;
  kickoff_time: string | null;
};

export type PlayerPastSeason = {
  season_name: string;
  element_code: number;
  start_cost: number;
  end_cost: number;
  total_points: number;
  minutes: number;
  goals_scored: number;
  assists: number;
  clean_sheets: number;
};

export type ElementSummary = {
  fixtures: PlayerUpcomingFixture[]; // remaining fixtures this season
  history: PlayerSeasonGameweek[]; // per-gameweek stats this season
  history_past: PlayerPastSeason[]; // previous seasons
};

export type Fixture = {
  id: number;
  event: number | null;
  team_h: number;
  team_a: number;
  team_h_score: number | null;
  team_a_score: number | null;
  team_h_difficulty: number;
  team_a_difficulty: number;
  finished: boolean;
  started?: boolean;
  kickoff_time: string | null;
};

export type Entry = {
  id: number;
  name: string;
  player_first_name: string;
  player_last_name: string;
  player_region_name?: string;
  summary_overall_points: number;
  summary_overall_rank: number;
  summary_event_points: number;
  summary_event_rank: number;
  current_event: number;
  last_deadline_bank: number;
  last_deadline_value: number;
  last_deadline_total_transfers?: number;
  started_event?: number;
  favourite_team?: number | null;
  leagues?: { classic?: { id: number; name: string; entry_rank?: number }[] };
};

export type EntryEventHistory = {
  event: number;
  points: number;
  total_points: number;
  rank: number;
  overall_rank: number;
  bank: number;
  value: number;
  event_transfers: number;
  event_transfers_cost: number;
  points_on_bench: number;
};

export type EntryPastSeason = {
  season_name: string;
  total_points: number;
  rank: number;
};

export type EntryChip = {
  name: string;
  time?: string;
  event: number;
};

export type EntryHistory = {
  current: EntryEventHistory[];
  past: EntryPastSeason[];
  chips: EntryChip[];
};

export type EntryPick = {
  element: number;
  position: number; // 1-11 starting, 12-15 bench
  multiplier: number;
  is_captain: boolean;
  is_vice_captain: boolean;
};

export type EntryPicks = {
  active_chip: string | null;
  automatic_subs: unknown[];
  entry_history: EntryEventHistory;
  picks: EntryPick[];
};

export type LeagueStandingRow = {
  id: number;
  entry: number; // entry id — drill into fpl_get_entry / fpl_get_entry_picks
  entry_name: string;
  player_name: string;
  rank: number;
  last_rank: number;
  event_total: number;
  total: number;
};

export type ClassicLeagueStandings = {
  league: { id: number; name: string; created?: string; league_type?: string; scoring?: string };
  standings: { has_next: boolean; page: number; results: LeagueStandingRow[] };
};

// --- Fetch helpers (one per endpoint) --------------------------------------

/** GET /bootstrap-static/ — game-wide data: players, teams, gameweeks, positions. */
export const fetchBootstrapStatic = () => apiGet<BootstrapStatic>(`${BASE}/bootstrap-static/`, { label: 'FPL' });

/** GET /element-summary/{player_id}/ — upcoming fixtures, this-season and past-season stats. */
export const fetchElementSummary = (playerId: number) =>
  apiGet<ElementSummary>(`${BASE}/element-summary/${playerId}/`, { label: 'FPL' });

/** GET /fixtures/ or /fixtures/?event={gw} — all fixtures, optionally one gameweek. */
export const fetchFixtures = (options: { event?: number } = {}) =>
  apiGet<Fixture[]>(`${BASE}/fixtures/`, { query: { event: options.event }, label: 'FPL' });

/** GET /entry/{team_id}/ — manager/team overview: points, rank, squad value. */
export const fetchEntry = (entryId: number) => apiGet<Entry>(`${BASE}/entry/${entryId}/`, { label: 'FPL' });

/** GET /entry/{team_id}/history/ — per-gameweek season history, past seasons, chips played. */
export const fetchEntryHistory = (entryId: number) =>
  apiGet<EntryHistory>(`${BASE}/entry/${entryId}/history/`, { label: 'FPL' });

/** GET /entry/{team_id}/event/{gw}/picks/ — the 15-man squad picked for one gameweek. */
export const fetchEntryPicks = (entryId: number, event: number) =>
  apiGet<EntryPicks>(`${BASE}/entry/${entryId}/event/${event}/picks/`, { label: 'FPL' });

/** GET /leagues-classic/{league_id}/standings/?page_standings={n} — classic league table, 50 per page. */
export const fetchClassicLeagueStandings = (leagueId: number, options: { page?: number } = {}) =>
  apiGet<ClassicLeagueStandings>(`${BASE}/leagues-classic/${leagueId}/standings/`, {
    query: { page_standings: options.page ?? 1 },
    label: 'FPL'
  });
