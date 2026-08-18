// Tests for the FPL API client helpers — all network access is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockFetch } from '@raynard/plugin-sdk/testing';
import {
  fetchBootstrapStatic,
  fetchElementSummary,
  fetchFixtures,
  fetchEntry,
  fetchEntryHistory,
  fetchEntryPicks,
  fetchClassicLeagueStandings,
  BASE
} from './client.ts';

test('fetchBootstrapStatic GETs /bootstrap-static/ and returns elements, teams and events', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/bootstrap-static/`);
    return {
      body: {
        elements: [{ id: 1, web_name: 'Salah', first_name: 'Mohamed' }],
        teams: [{ id: 12, name: 'Liverpool', short_name: 'LIV' }],
        events: [{ id: 5, name: 'Gameweek 5', is_current: true }],
        element_types: [{ id: 4, singular_name_short: 'MID' }]
      }
    };
  });
  try {
    const data = await fetchBootstrapStatic();
    assert.equal(data.elements.length, 1);
    assert.equal(data.elements[0].web_name, 'Salah');
    assert.equal(data.teams[0].short_name, 'LIV');
    assert.equal(data.events[0].id, 5);
  } finally {
    mock.restore();
  }
});

test('fetchElementSummary GETs /element-summary/{id}/ with fixtures, history and stats', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/element-summary/302/`);
    return {
      body: {
        fixtures: [{ id: 10, team_h: 12, team_a: 4, event: 6, difficulty: 3 }],
        history: [{ element: 302, round: 5, total_points: 12, minutes: 90 }],
        history_past: [{ season_name: '2023/24', total_points: 244 }]
      }
    };
  });
  try {
    const data = await fetchElementSummary(302);
    assert.equal(data.fixtures[0].event, 6);
    assert.equal(data.history[0].total_points, 12);
    assert.equal(data.history_past[0].season_name, '2023/24');
  } finally {
    mock.restore();
  }
});

test('fetchFixtures without filters GETs /fixtures/', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/fixtures/`);
    return { body: [{ id: 1, event: 1, team_h: 12, team_a: 4, team_h_score: 2, team_a_score: 0 }] };
  });
  try {
    const fixtures = await fetchFixtures();
    assert.equal(fixtures.length, 1);
    assert.equal(fixtures[0].team_h_score, 2);
  } finally {
    mock.restore();
  }
});

test('fetchFixtures with an event GETs /fixtures/?event={gw}', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/fixtures/?event=7`);
    return { body: [{ id: 61, event: 7, team_h: 1, team_a: 2, finished: false }] };
  });
  try {
    const fixtures = await fetchFixtures({ event: 7 });
    assert.equal(fixtures[0].event, 7);
  } finally {
    mock.restore();
  }
});

test('fetchEntry GETs /entry/{id}/ and returns team info', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/entry/12345/`);
    return {
      body: {
        id: 12345,
        name: 'Klopp Kids',
        player_first_name: 'Jane',
        player_last_name: 'Doe',
        summary_overall_points: 512,
        summary_overall_rank: 20344
      }
    };
  });
  try {
    const entry = await fetchEntry(12345);
    assert.equal(entry.name, 'Klopp Kids');
    assert.equal(entry.summary_overall_rank, 20344);
  } finally {
    mock.restore();
  }
});

test('fetchEntryHistory GETs /entry/{id}/history/ with current season, past seasons and chips', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/entry/12345/history/`);
    return {
      body: {
        current: [{ event: 5, points: 78, overall_rank: 20000, value: 1005 }],
        past: [{ season_name: '2023/24', total_points: 2200, rank: 50000 }],
        chips: [{ name: 'wildcard', event: 4 }]
      }
    };
  });
  try {
    const history = await fetchEntryHistory(12345);
    assert.equal(history.current[0].points, 78);
    assert.equal(history.past[0].season_name, '2023/24');
    assert.equal(history.chips[0].name, 'wildcard');
  } finally {
    mock.restore();
  }
});

test('fetchEntryPicks GETs /entry/{id}/event/{gw}/picks/', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/entry/12345/event/5/picks/`);
    return {
      body: {
        active_chip: 'bench boost',
        picks: [{ element: 302, position: 1, is_captain: true, is_vice_captain: false, multiplier: 2 }],
        entry_history: { event: 5, points: 78, overall_rank: 20000, bank: 12, value: 1005 }
      }
    };
  });
  try {
    const picks = await fetchEntryPicks(12345, 5);
    assert.equal(picks.picks.length, 1);
    assert.equal(picks.picks[0].is_captain, true);
    assert.equal(picks.entry_history.points, 78);
  } finally {
    mock.restore();
  }
});

test('fetchClassicLeagueStandings GETs /leagues-classic/{id}/standings/ and pages', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/leagues-classic/314/standings/?page_standings=2`);
    return {
      body: {
        league: { id: 314, name: 'Work League' },
        standings: {
          has_next: false,
          page: 2,
          results: [{ id: 99, entry: 12345, entry_name: 'Klopp Kids', player_name: 'Jane Doe', rank: 1, total: 512 }]
        }
      }
    };
  });
  try {
    const standings = await fetchClassicLeagueStandings(314, { page: 2 });
    assert.equal(standings.league.name, 'Work League');
    assert.equal(standings.standings.results[0].entry_name, 'Klopp Kids');
  } finally {
    mock.restore();
  }
});

test('fetchClassicLeagueStandings defaults to page 1', async () => {
  const mock = mockFetch((url) => {
    assert.equal(url, `${BASE}/leagues-classic/314/standings/?page_standings=1`);
    return {
      body: {
        league: { id: 314, name: 'Work League' },
        standings: { has_next: true, page: 1, results: [] }
      }
    };
  });
  try {
    await fetchClassicLeagueStandings(314);
  } finally {
    mock.restore();
  }
});

test('client surfaces API errors with endpoint context', async () => {
  const mock = mockFetch(() => ({ status: 404, body: { detail: 'Not found.' } }));
  try {
    await assert.rejects(() => fetchEntry(999), /404/);
  } finally {
    mock.restore();
  }
});
