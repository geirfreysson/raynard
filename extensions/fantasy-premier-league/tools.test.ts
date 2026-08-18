// Tests for every exported FPL tool — network fully mocked via mockFetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch, expectToolResult } from '@raynard/plugin-sdk/testing';
import { tools } from './tools.ts';
import { BASE } from './client.ts';

const BOOTSTRAP = {
  elements: [
    {
      id: 302,
      web_name: 'Salah',
      first_name: 'Mohamed',
      second_name: 'Salah',
      team: 12,
      element_type: 3,
      now_cost: 128,
      total_points: 95,
      points_per_game: '7.3',
      form: '8.0',
      goals_scored: 9,
      assists: 6,
      clean_sheets: 5,
      minutes: 1042,
      selected_by_percent: '45.2',
      status: 'a',
      news: '',
      chance_of_playing_next_round: 100,
      ict_index: '120.5',
      expected_goals: '6.50',
      expected_assists: '4.20',
      transfers_in_event: 500000,
      transfers_out_event: 10000
    },
    {
      id: 355,
      web_name: 'Haaland',
      first_name: 'Erling',
      second_name: 'Haaland',
      team: 13,
      element_type: 4,
      now_cost: 152,
      total_points: 88,
      points_per_game: '8.8',
      form: '7.5',
      goals_scored: 11,
      assists: 1,
      clean_sheets: 0,
      minutes: 810,
      selected_by_percent: '55.1',
      status: 'a',
      news: '',
      chance_of_playing_next_round: 100,
      ict_index: '98.0',
      expected_goals: '9.10',
      expected_assists: '1.40',
      transfers_in_event: 300000,
      transfers_out_event: 50000
    }
  ],
  teams: [
    { id: 12, name: 'Liverpool', short_name: 'LIV', strength: 4, position: 0 },
    { id: 13, name: 'Man City', short_name: 'MCI', strength: 5, position: 0 },
    { id: 4, name: 'Arsenal', short_name: 'ARS', strength: 4, position: 0 }
  ],
  events: [
    { id: 4, name: 'Gameweek 4', is_current: false, is_next: false, finished: true, deadline_time: '2024-09-14T10:00:00Z', average_entry_score: 55, highest_score: 130 },
    { id: 5, name: 'Gameweek 5', is_current: true, is_next: false, finished: false, deadline_time: '2024-09-21T10:00:00Z', average_entry_score: 0, highest_score: null },
    { id: 6, name: 'Gameweek 6', is_current: false, is_next: true, finished: false, deadline_time: '2024-09-28T10:00:00Z', average_entry_score: 0, highest_score: null }
  ],
  element_types: [
    { id: 1, singular_name_short: 'GKP' },
    { id: 2, singular_name_short: 'DEF' },
    { id: 3, singular_name_short: 'MID' },
    { id: 4, singular_name_short: 'FWD' }
  ]
};

const SUMMARY_302 = {
  fixtures: [
    { id: 51, event: 5, team_h: 12, team_a: 4, team_h_difficulty: 3, team_a_difficulty: 4, kickoff_time: '2024-09-21T14:00:00Z', is_home: true, difficulty: 3 },
    { id: 61, event: 6, team_h: 13, team_a: 12, team_h_difficulty: 4, team_a_difficulty: 3, kickoff_time: '2024-09-28T16:30:00Z', is_home: false, difficulty: 3 }
  ],
  history: [
    { element: 302, round: 3, total_points: 14, minutes: 90, goals_scored: 2, assists: 0, clean_sheets: 0, bonus: 3, value: 126, opponent_team: 4, was_home: true, kickoff_time: '2024-09-01T15:00:00Z' },
    { element: 302, round: 4, total_points: 2, minutes: 90, goals_scored: 0, assists: 0, clean_sheets: 0, bonus: 0, value: 128, opponent_team: 13, was_home: false, kickoff_time: '2024-09-14T11:30:00Z' }
  ],
  history_past: [
    { season_name: '2023/24', element_code: 118748, start_cost: 125, end_cost: 138, total_points: 244, minutes: 2900, goals_scored: 18, assists: 10, clean_sheets: 7 }
  ]
};

const FIXTURES_GW5 = [
  { id: 41, event: 5, team_h: 12, team_a: 4, team_h_score: 2, team_a_score: 1, finished: true, kickoff_time: '2024-09-21T14:00:00Z', team_h_difficulty: 3, team_a_difficulty: 4, started: true },
  { id: 42, event: 5, team_h: 13, team_a: 12, team_h_score: null, team_a_score: null, finished: false, kickoff_time: '2024-09-22T15:30:00Z', team_h_difficulty: 4, team_a_difficulty: 3, started: false }
];

const ENTRY = {
  id: 12345,
  name: 'Klopp Kids',
  player_first_name: 'Jane',
  player_last_name: 'Doe',
  player_region_name: 'England',
  summary_overall_points: 512,
  summary_overall_rank: 20344,
  summary_event_points: 78,
  summary_event_rank: 120000,
  current_event: 5,
  last_deadline_bank: 12,
  last_deadline_value: 1005,
  last_deadline_total_transfers: 3,
  started_event: 1,
  favourite_team: 12,
  leagues: { classic: [{ id: 314, name: 'Work League', entry_rank: 1 }] }
};

const ENTRY_HISTORY = {
  current: [
    { event: 4, points: 65, total_points: 434, rank: 25000, overall_rank: 25000, bank: 15, value: 1003, event_transfers: 1, event_transfers_cost: 0, points_on_bench: 4 },
    { event: 5, points: 78, total_points: 512, rank: 120000, overall_rank: 20344, bank: 12, value: 1005, event_transfers: 1, event_transfers_cost: 4, points_on_bench: 9 }
  ],
  past: [{ season_name: '2023/24', total_points: 2200, rank: 50000 }],
  chips: [{ name: 'wildcard', time: '2024-09-13T18:00:00Z', event: 4 }]
};

const PICKS = {
  active_chip: 'bboost',
  automatic_subs: [],
  entry_history: { event: 5, points: 78, total_points: 512, overall_rank: 20344, bank: 12, value: 1005, event_transfers: 1, event_transfers_cost: 4, points_on_bench: 9 },
  picks: [
    { element: 302, position: 1, multiplier: 2, is_captain: true, is_vice_captain: false },
    { element: 355, position: 2, multiplier: 1, is_captain: false, is_vice_captain: true }
  ]
};

const STANDINGS = {
  league: { id: 314, name: 'Work League', created: '2024-08-01T00:00:00Z', league_type: 'x', scoring: 'c' },
  standings: {
    has_next: false,
    page: 1,
    results: [
      { id: 9001, entry: 12345, entry_name: 'Klopp Kids', player_name: 'Jane Doe', rank: 1, last_rank: 2, event_total: 78, total: 512 },
      { id: 9002, entry: 67890, entry_name: 'City Slickers', player_name: 'John Smith', rank: 2, last_rank: 1, event_total: 60, total: 500 }
    ]
  }
};

function mockAll(handler?: (url: string) => { body?: unknown; status?: number } | undefined) {
  return mockFetch((url) => {
    if (handler) {
      const specific = handler(url);
      if (specific) return specific;
    }
    if (url === `${BASE}/bootstrap-static/`) return { body: BOOTSTRAP };
    if (url === `${BASE}/element-summary/302/`) return { body: SUMMARY_302 };
    if (url === `${BASE}/fixtures/?event=5`) return { body: FIXTURES_GW5 };
    if (url === `${BASE}/fixtures/`) return { body: FIXTURES_GW5 };
    if (url === `${BASE}/entry/12345/`) return { body: ENTRY };
    if (url === `${BASE}/entry/12345/history/`) return { body: ENTRY_HISTORY };
    if (url === `${BASE}/entry/12345/event/5/picks/`) return { body: PICKS };
    if (url.startsWith(`${BASE}/leagues-classic/314/standings/`)) return { body: STANDINGS };
    return { status: 404, body: { detail: 'Not found.' } };
  });
}

// --- fpl_get_game_overview -------------------------------------------------

test('fpl_get_game_overview returns counts, current gameweek and a card-ready data object', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_game_overview.execute({});
    expectToolResult(result);
    assert.match(result.text, /2 players/);
    assert.match(result.text, /Gameweek 5/);
    assert.ok(result.data, 'final-data tool must return data');
    assert.equal(result.data.playerCount, 2);
    assert.equal(result.data.currentEvent, 'Gameweek 5');
  } finally {
    mock.restore();
  }
});

// --- fpl_search_players ----------------------------------------------------

test('fpl_search_players finds players by name with non-empty ids and useful text', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_search_players.execute({ query: 'salah' });
    expectToolResult(result);
    assert.ok(result.data, 'every API tool must return card data');
    assert.equal(result.data.matchCount, 1);
    assert.ok(Array.isArray(result.data.players));
    assert.ok(tools.fpl_search_players.card, 'search tool must declare a card');
    assert.match(result.text, /302/);
    assert.match(result.text, /Salah/);
    assert.ok(result.references.some((r) => r.referenceId === '302'));
  } finally {
    mock.restore();
  }
});

test('fpl_search_players filters by team and position', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_search_players.execute({ team_id: 13, position: 'FWD' });
    expectToolResult(result);
    assert.match(result.text, /Haaland/);
    assert.ok(!result.text.includes('Salah'));
  } finally {
    mock.restore();
  }
});

test('fpl_search_players reports a clear message when nothing matches', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_search_players.execute({ query: 'zzzz-no-such-player' });
    assert.match(result.text, /[Nn]o players/);
    assert.equal(result.data?.matchCount, 0);
    assert.ok(Array.isArray(result.data?.players));
  } finally {
    mock.restore();
  }
});

// --- fpl_get_player (final data: card + data) ------------------------------

test('fpl_get_player returns stats, upcoming fixtures and history with citations', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_player.execute({ player_id: 302 });
    expectToolResult(result);
    assert.match(result.text, /Mohamed Salah/);
    assert.match(result.text, /95/);
    assert.match(result.text, /2023\/24/);
    assert.ok(result.data, 'final-data tool must return data');
    assert.equal(result.data.name, 'Mohamed Salah');
    assert.equal(result.data.totalPoints, 95);
    assert.ok(Array.isArray(result.data.upcomingFixtures));
    assert.ok(Array.isArray(result.data.recentHistory));
    assert.ok(tools.fpl_get_player.card, 'final-data tool must declare a card');
  } finally {
    mock.restore();
  }
});

test('fpl_get_player data exposes every field its card binds to', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_player.execute({ player_id: 302 });
    const data = result.data as Record<string, unknown>;
    for (const field of ['price', 'form', 'pointsPerGame', 'goals', 'assists', 'selectedBy', 'team', 'position', 'status']) {
      assert.ok(field in data, `data.${field} must exist for the card`);
    }
  } finally {
    mock.restore();
  }
});

// --- fpl_list_fixtures -----------------------------------------------------

test('fpl_list_fixtures lists fixtures for a gameweek with ids and scores', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_list_fixtures.execute({ event: 5 });
    expectToolResult(result);
    assert.ok(result.data, 'every API tool must return card data');
    assert.equal(result.data.fixturesShown, 2);
    assert.ok(Array.isArray(result.data.fixtures));
    assert.ok(tools.fpl_list_fixtures.card, 'fixture list tool must declare a card');
    assert.match(result.text, /41/);
    assert.match(result.text, /Liverpool 2 - 1 Arsenal/);
    assert.match(result.text, /42/);
  } finally {
    mock.restore();
  }
});

test('fpl_list_fixtures without an event lists all fixtures', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_list_fixtures.execute({});
    expectToolResult(result);
    assert.match(result.text, /Liverpool/);
  } finally {
    mock.restore();
  }
});

// --- fpl_get_entry (final data) --------------------------------------------

test('fpl_get_entry returns team info with a card-bound data object', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_entry.execute({ entry_id: 12345 });
    expectToolResult(result);
    assert.match(result.text, /Klopp Kids/);
    assert.match(result.text, /20,?344/);
    assert.ok(result.data);
    assert.equal(result.data.teamName, 'Klopp Kids');
    assert.equal(result.data.overallPoints, 512);
    assert.ok(tools.fpl_get_entry.card);
  } finally {
    mock.restore();
  }
});

// --- fpl_get_entry_history (final data) ------------------------------------

test('fpl_get_entry_history returns per-gameweek history, past seasons and chips', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_entry_history.execute({ entry_id: 12345 });
    expectToolResult(result);
    assert.match(result.text, /Gameweek 5/);
    assert.match(result.text, /2023\/24/);
    assert.match(result.text, /wildcard/i);
    assert.ok(result.data);
    assert.ok(Array.isArray(result.data.seasonRows));
    assert.ok(Array.isArray(result.data.pastSeasons));
    assert.ok(tools.fpl_get_entry_history.card);
  } finally {
    mock.restore();
  }
});

// --- fpl_get_entry_picks (final data) --------------------------------------

test('fpl_get_entry_picks resolves picks to player names with captain flagged', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_entry_picks.execute({ entry_id: 12345, event: 5 });
    expectToolResult(result);
    assert.match(result.text, /Salah/);
    assert.match(result.text, /[Cc]aptain/);
    assert.match(result.text, /bench boost/i);
    assert.ok(result.data);
    assert.ok(Array.isArray(result.data.lineup));
    assert.equal(result.data.gameweekPoints, 78);
    assert.ok(tools.fpl_get_entry_picks.card);
  } finally {
    mock.restore();
  }
});

// --- fpl_get_league_standings (final data) ---------------------------------

test('fpl_get_league_standings returns ranked entries for a classic league', async () => {
  const mock = mockAll();
  try {
    const result = await tools.fpl_get_league_standings.execute({ league_id: 314 });
    expectToolResult(result);
    assert.match(result.text, /Work League/);
    assert.match(result.text, /Klopp Kids/);
    assert.match(result.text, /12345/);
    assert.ok(result.data);
    assert.equal(result.data.leagueName, 'Work League');
    assert.ok(Array.isArray(result.data.standings));
    assert.ok(tools.fpl_get_league_standings.card);
  } finally {
    mock.restore();
  }
});

test('fpl_get_league_standings passes the requested page through to the API', async () => {
  const mock = mockAll();
  try {
    await tools.fpl_get_league_standings.execute({ league_id: 314, page: 3 });
    assert.ok(mock.calls.some((u) => u.includes('page_standings=3')));
  } finally {
    mock.restore();
  }
});

// --- validation ------------------------------------------------------------

test('tools reject invalid ids with a clear error', async () => {
  const mock = mockAll();
  try {
    await assert.rejects(() => tools.fpl_get_player.execute({ player_id: 0 }), /player_id/);
    await assert.rejects(() => tools.fpl_get_entry.execute({ entry_id: -3 }), /entry_id/);
    await assert.rejects(() => tools.fpl_get_league_standings.execute({ league_id: 'x' }), /league_id/);
  } finally {
    mock.restore();
  }
});

test('API failures surface as descriptive errors', async () => {
  const mock = mockAll(() => ({ status: 500, body: { error: 'boom' } }));
  try {
    await assert.rejects(() => tools.fpl_get_entry.execute({ entry_id: 12345 }), /500.*boom/);
  } finally {
    mock.restore();
  }
});

test('every FPL API tool declares a result card', () => {
  for (const [name, tool] of Object.entries(tools)) {
    assert.ok(tool.card, `${name} must declare a card`);
  }
});
