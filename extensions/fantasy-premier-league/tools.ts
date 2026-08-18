// Fantasy Premier League tool registry. Every tool declares a fixed card
// template and returns matching `data`, including list and search calls.
import {
  fetchBootstrapStatic,
  fetchElementSummary,
  fetchFixtures,
  fetchEntry,
  fetchEntryHistory,
  fetchEntryPicks,
  fetchClassicLeagueStandings,
  BASE,
  type BootstrapStatic,
  type FplPlayer,
  type Fixture
} from './client.ts';
import {
  createApiReference,
  defineTools,
  requireNonEmpty,
  requirePositiveInt,
  type ApiReference,
  type ToolResult
} from '@raynard/plugin-sdk';

// --- Shared lookup helpers --------------------------------------------------

const POSITION_LABELS: Record<string, string> = { GKP: 'Goalkeeper', DEF: 'Defender', MID: 'Midfielder', FWD: 'Forward' };

const STATUS_LABELS: Record<string, string> = {
  a: 'Available',
  d: 'Doubtful',
  i: 'Injured',
  s: 'Suspended',
  u: 'Unavailable',
  n: 'Not in squad'
};

const CHIP_LABELS: Record<string, string> = {
  wildcard: 'Wildcard',
  freehit: 'Free Hit',
  bboost: 'Bench Boost',
  '3xc': 'Triple Captain'
};

type Lookups = { teamName: (id: number) => string; positionOf: (p: FplPlayer) => string };

function buildLookups(bootstrap: BootstrapStatic): Lookups {
  const teamById = new Map(bootstrap.teams.map((t) => [t.id, t]));
  const posById = new Map(bootstrap.element_types.map((t) => [t.id, t.singular_name_short]));
  return {
    teamName: (id) => teamById.get(id)?.name ?? `Team ${id}`,
    positionOf: (p) => POSITION_LABELS[posById.get(p.element_type) ?? ''] ?? `Type ${p.element_type}`
  };
}

const formatPrice = (nowCost: number) => `£${(nowCost / 10).toFixed(1)}m`;
const formatRank = (rank: number) => rank.toLocaleString('en-GB');
const chipLabel = (chip: string | null | undefined) =>
  chip ? (CHIP_LABELS[chip] ?? chip) : 'None';

const playerLabel = (p: FplPlayer) => `${p.first_name} ${p.second_name}`.trim() || p.web_name;

function playerLine(p: FplPlayer, lookups: Lookups): string {
  return `${p.id}: ${playerLabel(p)} (${lookups.positionOf(p)}, ${lookups.teamName(p.team)}) — ${formatPrice(p.now_cost)}, ${p.total_points} pts, form ${p.form}`;
}

function fixtureLine(f: Fixture, lookups: Lookups): string {
  const home = lookups.teamName(f.team_h);
  const away = lookups.teamName(f.team_a);
  const score =
    f.started || f.finished || (f.team_h_score !== null && f.team_a_score !== null)
      ? `${home} ${f.team_h_score ?? '?'} - ${f.team_a_score ?? '?'} ${away}${f.finished ? '' : ' (in progress)'}`
      : `${home} v ${away}${f.kickoff_time ? ` (${new Date(f.kickoff_time).toUTCString()})` : ''}`;
  return `${f.id}: GW${f.event ?? '?'} — ${score}`;
}

function playerCitation(p: FplPlayer, extra?: string): ApiReference {
  return createApiReference({
    id: String(p.id),
    label: playerLabel(p),
    sourceUrl: `${BASE}/element-summary/${p.id}/`,
    quote: extra ?? `${playerLabel(p)} (${p.web_name}) — ${p.total_points} pts, ${formatPrice(p.now_cost)}`,
    payload: p
  });
}

// --- Tools ------------------------------------------------------------------

export const tools = defineTools({
  fpl_get_game_overview: {
    description:
      'Get the overall state of the Fantasy Premier League game: total player/team counts, the current and next gameweek with deadlines, and average scores. Use this first to discover which gameweek is live before calling gameweek-specific tools like fpl_list_fixtures or fpl_get_entry_picks.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    card: {
      name: { singular: 'season snapshot', plural: 'season snapshots' },
      title: 'FPL season overview',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Players', field: 'playerCount' },
            { label: 'Teams', field: 'teamCount' },
            { label: 'Gameweeks', field: 'eventCount' }
          ]
        },
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Current gameweek', field: 'currentEvent' },
            { label: 'Next gameweek', field: 'nextEvent' },
            { label: 'Next deadline', field: 'nextDeadline' },
            { label: 'Last GW average', field: 'lastAverageScore' },
            { label: 'Last GW high score', field: 'lastHighScore' }
          ]
        }
      ]
    },
    async execute(): Promise<ToolResult> {
      const data = await fetchBootstrapStatic();
      const current = data.events.find((e) => e.is_current);
      const next = data.events.find((e) => e.is_next);
      const lastFinished = [...data.events].reverse().find((e) => e.finished);
      const lines = [
        `FPL overview: ${data.elements.length} players, ${data.teams.length} teams, ${data.events.length} gameweeks.`,
        current ? `Current: ${current.name} (deadline ${current.deadline_time ?? 'tbc'}).` : 'No live gameweek right now.',
        next ? `Next: ${next.name} (deadline ${next.deadline_time ?? 'tbc'}).` : 'No upcoming gameweek scheduled.',
        lastFinished
          ? `Last finished: ${lastFinished.name} — average ${lastFinished.average_entry_score ?? 0} pts, high score ${lastFinished.highest_score ?? 'n/a'}.`
          : 'No finished gameweek yet this season.'
      ];
      return {
        text: lines.join('\n'),
        data: {
          playerCount: data.elements.length,
          teamCount: data.teams.length,
          eventCount: data.events.length,
          currentEvent: current?.name ?? 'None',
          nextEvent: next?.name ?? 'None',
          nextDeadline: next?.deadline_time ?? current?.deadline_time ?? 'TBC',
          lastAverageScore: lastFinished?.average_entry_score ?? 'n/a',
          lastHighScore: lastFinished?.highest_score ?? 'n/a'
        },
        references: [
          createApiReference({
            id: 'bootstrap-static',
            label: 'FPL game overview (bootstrap-static)',
            sourceUrl: `${BASE}/bootstrap-static/`,
            quote: `${data.elements.length} players, ${data.teams.length} teams, current gameweek: ${current?.name ?? 'none'}`,
            payload: {
              playerCount: data.elements.length,
              teamCount: data.teams.length,
              events: data.events.map((e) => ({ id: e.id, name: e.name, is_current: e.is_current, is_next: e.is_next, finished: e.finished }))
            }
          })
        ]
      };
    }
  },

  fpl_search_players: {
    description:
      'Search FPL players by name and/or filter by team and position, sorted by total points. Returns a card with candidate player ids, prices, form and points — use the ids with fpl_get_player for full stats, fixtures and history.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name fragment to match against first name, last name or web name (case-insensitive).' },
        team_id: { type: 'integer', description: 'Optional FPL team id to restrict the search to one club.' },
        position: {
          type: 'string',
          enum: ['GKP', 'DEF', 'MID', 'FWD'],
          description: 'Optional position filter: GKP (goalkeeper), DEF (defender), MID (midfielder), FWD (forward).'
        },
        limit: { type: 'integer', description: 'Maximum number of players to return (default 10, max 50).' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'player search', plural: 'player searches' },
      title: 'FPL players — {{matchCount}} matches',
      layout: [
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Name', field: 'query' },
            { label: 'Position', field: 'position' },
            { label: 'Team', field: 'team' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: 'ID', field: 'id' },
            { header: 'Player', field: 'name' },
            { header: 'Pos', field: 'position' },
            { header: 'Team', field: 'team' },
            { header: 'Price', field: 'price' },
            { header: 'Pts', field: 'points' },
            { header: 'Form', field: 'form' }
          ],
          rows: 'players'
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const query = String(args?.query ?? '').trim().toLowerCase();
      const teamId = args?.team_id === undefined ? undefined : requirePositiveInt(args.team_id, 'team_id');
      const position = args?.position === undefined ? undefined : requireNonEmpty(args.position, 'position').toUpperCase();
      const limit = Math.min(Number(args?.limit ?? 10) || 10, 50);
      const data = await fetchBootstrapStatic();
      const lookups = buildLookups(data);
      const posIdByShort = new Map(data.element_types.map((t) => [t.singular_name_short, t.id]));
      const matches = data.elements
        .filter((p) => !query || `${p.first_name} ${p.second_name} ${p.web_name}`.toLowerCase().includes(query))
        .filter((p) => teamId === undefined || p.team === teamId)
        .filter((p) => position === undefined || p.element_type === posIdByShort.get(position))
        .sort((a, b) => b.total_points - a.total_points)
        .slice(0, limit);
      const cardData = {
        matchCount: matches.length,
        query: query || 'Any name',
        position: position || 'Any position',
        team: teamId === undefined ? 'Any team' : lookups.teamName(teamId),
        players: matches.map((p) => ({
          id: p.id,
          name: playerLabel(p),
          position: lookups.positionOf(p),
          team: lookups.teamName(p.team),
          price: formatPrice(p.now_cost),
          points: p.total_points,
          form: p.form
        }))
      };
      if (matches.length === 0) {
        return {
          text: `No players matched the search${query ? ` for "${query}"` : ''}. Try a different name, team id or position.`,
          data: cardData,
          references: [
            createApiReference({
              id: 'player-search-empty',
              label: 'FPL player search (no matches)',
              sourceUrl: `${BASE}/bootstrap-static/`,
              quote: `0 of ${data.elements.length} players matched the filters.`,
              payload: { query, team_id: teamId, position, totalPlayers: data.elements.length }
            })
          ]
        };
      }
      return {
        text: `Top ${matches.length} matching players:\n${matches.map((p) => playerLine(p, lookups)).join('\n')}`,
        data: cardData,
        references: matches.map((p) => playerCitation(p, playerLine(p, lookups)))
      };
    }
  },

  fpl_get_player: {
    description:
      'Get a full profile for one FPL player: season stats (points, goals, assists, xG/xA, price, ownership), upcoming fixtures with difficulty ratings, recent gameweek-by-gameweek returns and past-season history. Find the player_id with fpl_search_players first.',
    parameters: {
      type: 'object',
      required: ['player_id'],
      properties: {
        player_id: { type: 'integer', description: 'FPL element id of the player, e.g. from fpl_search_players.' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'player', plural: 'players' },
      title: '{{name}} — {{team}} ({{position}})',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Total points', field: 'totalPoints' },
            { label: 'Price', field: 'price' },
            { label: 'Form', field: 'form' },
            { label: 'Owned by', field: 'selectedBy' }
          ]
        },
        {
          component: 'MetricRow',
          items: [
            { label: 'Goals', field: 'goals' },
            { label: 'Assists', field: 'assists' },
            { label: 'xG', field: 'expectedGoals' },
            { label: 'xA', field: 'expectedAssists' }
          ]
        },
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Status', field: 'status' },
            { label: 'Points per game', field: 'pointsPerGame' },
            { label: 'Minutes', field: 'minutes' }
          ]
        },
        {
          component: 'Section',
          title: 'Upcoming fixtures',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: 'GW', field: 'event' },
                { header: 'Opponent', field: 'opponent' },
                { header: 'Venue', field: 'venue' },
                { header: 'Difficulty', field: 'difficulty' }
              ],
              rows: 'upcomingFixtures'
            }
          ]
        },
        {
          component: 'Section',
          title: 'Recent gameweeks',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: 'GW', field: 'round' },
                { header: 'Pts', field: 'totalPoints' },
                { header: 'Mins', field: 'minutes' },
                { header: 'G', field: 'goals' },
                { header: 'A', field: 'assists' }
              ],
              rows: 'recentHistory'
            }
          ]
        },
        {
          component: 'Section',
          title: 'Past seasons',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: 'Season', field: 'season' },
                { header: 'Pts', field: 'totalPoints' },
                { header: 'G', field: 'goals' },
                { header: 'A', field: 'assists' }
              ],
              rows: 'pastSeasons'
            }
          ]
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const playerId = requirePositiveInt(args?.player_id, 'player_id');
      const [bootstrap, summary] = await Promise.all([fetchBootstrapStatic(), fetchElementSummary(playerId)]);
      const lookups = buildLookups(bootstrap);
      const player = bootstrap.elements.find((p) => p.id === playerId);
      if (!player) throw new Error(`No FPL player found with id ${playerId}. Use fpl_search_players to find valid ids.`);
      const name = playerLabel(player);
      const status = STATUS_LABELS[player.status] ?? player.status;
      const upcoming = summary.fixtures.slice(0, 6).map((f) => ({
        event: f.event,
        opponent: lookups.teamName(f.is_home ? f.team_a : f.team_h),
        venue: f.is_home ? 'Home' : 'Away',
        difficulty: f.difficulty
      }));
      const recent = summary.history.slice(-6).map((h) => ({
        round: h.round,
        totalPoints: h.total_points,
        minutes: h.minutes,
        goals: h.goals_scored,
        assists: h.assists,
        bonus: h.bonus
      }));
      const pastSeasons = summary.history_past.map((s) => ({
        season: s.season_name,
        totalPoints: s.total_points,
        goals: s.goals_scored,
        assists: s.assists,
        minutes: s.minutes
      }));
      const lines = [
        `${name} (${lookups.positionOf(player)}, ${lookups.teamName(player.team)}) — ${formatPrice(player.now_cost)}, ${status}.`,
        `Season: ${player.total_points} pts (${player.points_per_game} ppg), form ${player.form}, owned by ${player.selected_by_percent}%.`,
        `Returns: ${player.goals_scored} goals, ${player.assists} assists, xG ${player.expected_goals}, xA ${player.expected_assists}, ${player.minutes} minutes.`,
        upcoming.length
          ? `Next fixtures: ${upcoming.map((f) => `GW${f.event} ${f.opponent} (${f.venue}, FDR ${f.difficulty})`).join('; ')}.`
          : 'No remaining fixtures.',
        recent.length
          ? `Recent: ${recent.map((h) => `GW${h.round} ${h.totalPoints}pts`).join(', ')}.`
          : 'No minutes played yet this season.',
        pastSeasons.length
          ? `Past seasons: ${pastSeasons.map((s) => `${s.season} ${s.totalPoints}pts`).join(', ')}.`
          : 'No previous Premier League seasons.'
      ];
      return {
        text: lines.join('\n'),
        data: {
          id: player.id,
          name,
          team: lookups.teamName(player.team),
          position: lookups.positionOf(player),
          price: formatPrice(player.now_cost),
          totalPoints: player.total_points,
          pointsPerGame: player.points_per_game,
          form: player.form,
          selectedBy: `${player.selected_by_percent}%`,
          status: player.news ? `${status} — ${player.news}` : status,
          goals: player.goals_scored,
          assists: player.assists,
          expectedGoals: player.expected_goals,
          expectedAssists: player.expected_assists,
          minutes: player.minutes,
          upcomingFixtures: upcoming,
          recentHistory: recent,
          pastSeasons
        },
        references: [
          createApiReference({
            id: String(player.id),
            label: `${name} — season summary`,
            sourceUrl: `${BASE}/element-summary/${player.id}/`,
            quote: `${player.total_points} pts, ${player.goals_scored}G ${player.assists}A, ${formatPrice(player.now_cost)}`,
            payload: summary
          }),
          playerCitation(player)
        ]
      };
    }
  },

  fpl_list_fixtures: {
    description:
      'List Premier League fixtures for one gameweek (or every fixture when no gameweek is given), with a card showing scores, kickoff times and difficulty ratings. Returns fixture ids and team ids for follow-up calls. Use fpl_get_game_overview to find the current gameweek number.',
    parameters: {
      type: 'object',
      properties: {
        event: { type: 'integer', description: 'Gameweek number (1-38). Omit to list every fixture in the season.' },
        team_id: { type: 'integer', description: 'Optional FPL team id to show only matches involving one club.' },
        limit: { type: 'integer', description: 'Maximum number of fixtures to return (default 20, max 100).' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'fixture list', plural: 'fixture lists' },
      title: '{{scope}} fixtures',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Shown', field: 'fixturesShown' },
            { label: 'Available', field: 'totalFixtures' }
          ]
        },
        { component: 'KeyValue', pairs: [{ label: 'Team filter', field: 'team' }] },
        {
          component: 'Table',
          columns: [
            { header: 'ID', field: 'id' },
            { header: 'GW', field: 'event' },
            { header: 'Home', field: 'home' },
            { header: 'Score', field: 'score' },
            { header: 'Away', field: 'away' },
            { header: 'H FDR', field: 'homeDifficulty' },
            { header: 'A FDR', field: 'awayDifficulty' },
            { header: 'Kickoff', field: 'kickoff' }
          ],
          rows: 'fixtures'
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const event = args?.event === undefined ? undefined : requirePositiveInt(args.event, 'event');
      const teamId = args?.team_id === undefined ? undefined : requirePositiveInt(args.team_id, 'team_id');
      const limit = Math.min(Number(args?.limit ?? 20) || 20, 100);
      const [fixtures, bootstrap] = await Promise.all([fetchFixtures(event === undefined ? {} : { event }), fetchBootstrapStatic()]);
      const lookups = buildLookups(bootstrap);
      const filtered = fixtures.filter((f) => teamId === undefined || f.team_h === teamId || f.team_a === teamId).slice(0, limit);
      const scope = event !== undefined ? `Gameweek ${event}` : 'All season';
      const cardData = {
        scope,
        fixturesShown: filtered.length,
        totalFixtures: fixtures.length,
        team: teamId === undefined ? 'Any team' : lookups.teamName(teamId),
        fixtures: filtered.map((f) => ({
          id: f.id,
          event: f.event ?? '—',
          home: lookups.teamName(f.team_h),
          away: lookups.teamName(f.team_a),
          score:
            f.team_h_score !== null && f.team_a_score !== null
              ? `${f.team_h_score}–${f.team_a_score}`
              : '—',
          homeDifficulty: f.team_h_difficulty,
          awayDifficulty: f.team_a_difficulty,
          kickoff: f.kickoff_time ? new Date(f.kickoff_time).toUTCString() : 'TBC'
        }))
      };
      if (filtered.length === 0) {
        return {
          text: `No fixtures found${event !== undefined ? ` for gameweek ${event}` : ''}${teamId !== undefined ? ` involving team ${teamId}` : ''}.`,
          data: cardData,
          references: [
            createApiReference({
              id: `fixtures-${event ?? 'all'}-empty`,
              label: 'FPL fixtures (no matches)',
              sourceUrl: `${BASE}/fixtures/${event !== undefined ? `?event=${event}` : ''}`,
              quote: 'No fixtures matched the requested filters.',
              payload: { event, team_id: teamId }
            })
          ]
        };
      }
      return {
        text: `${scope} fixtures (${filtered.length}${fixtures.length > filtered.length ? ` of ${fixtures.length}` : ''}):\n${filtered.map((f) => fixtureLine(f, lookups)).join('\n')}`,
        data: cardData,
        references: filtered.map((f) =>
          createApiReference({
            id: String(f.id),
            label: `GW${f.event ?? '?'}: ${lookups.teamName(f.team_h)} v ${lookups.teamName(f.team_a)}`,
            sourceUrl: `${BASE}/fixtures/${f.event !== null ? `?event=${f.event}` : ''}`,
            quote: fixtureLine(f, lookups),
            payload: f
          })
        )
      };
    }
  },

  fpl_get_entry: {
    description:
      'Get an FPL manager\'s team overview: team name, manager name, overall points and rank, latest gameweek points, squad value, bank balance and classic leagues entered. The entry_id is the number in a team\'s FPL URL, or found in league standings via fpl_get_league_standings.',
    parameters: {
      type: 'object',
      required: ['entry_id'],
      properties: {
        entry_id: { type: 'integer', description: 'FPL entry (team) id of the manager.' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'team', plural: 'teams' },
      title: '{{teamName}} — {{managerName}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Overall points', field: 'overallPoints' },
            { label: 'Overall rank', field: 'overallRank' },
            { label: 'GW points', field: 'gameweekPoints' }
          ]
        },
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Squad value', field: 'squadValue' },
            { label: 'In the bank', field: 'bank' },
            { label: 'Transfers made', field: 'totalTransfers' },
            { label: 'Region', field: 'region' }
          ]
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const entryId = requirePositiveInt(args?.entry_id, 'entry_id');
      const entry = await fetchEntry(entryId);
      const manager = `${entry.player_first_name} ${entry.player_last_name}`.trim();
      const value = `£${(entry.last_deadline_value / 10).toFixed(1)}m`;
      const bank = `£${(entry.last_deadline_bank / 10).toFixed(1)}m`;
      const classicLeagues = entry.leagues?.classic ?? [];
      const lines = [
        `${entry.name} — managed by ${manager}${entry.player_region_name ? ` (${entry.player_region_name})` : ''}.`,
        `Overall: ${entry.summary_overall_points} pts, rank ${formatRank(entry.summary_overall_rank)}.`,
        `Gameweek ${entry.current_event}: ${entry.summary_event_points} pts (GW rank ${formatRank(entry.summary_event_rank)}).`,
        `Squad value ${value}, in the bank ${bank}, ${entry.last_deadline_total_transfers ?? 0} transfers made.`,
        classicLeagues.length
          ? `Classic leagues: ${classicLeagues.map((l) => `${l.name} (league id ${l.id})`).join(', ')}.`
          : 'No classic leagues joined.'
      ];
      return {
        text: lines.join('\n'),
        data: {
          id: entry.id,
          teamName: entry.name,
          managerName: manager,
          region: entry.player_region_name ?? 'Unknown',
          overallPoints: entry.summary_overall_points,
          overallRank: formatRank(entry.summary_overall_rank),
          gameweekPoints: entry.summary_event_points,
          gameweek: entry.current_event,
          squadValue: value,
          bank,
          totalTransfers: entry.last_deadline_total_transfers ?? 0
        },
        references: [
          createApiReference({
            id: String(entry.id),
            label: `${entry.name} (${manager})`,
            sourceUrl: `${BASE}/entry/${entry.id}/`,
            quote: `${entry.summary_overall_points} pts, overall rank ${formatRank(entry.summary_overall_rank)}`,
            payload: entry
          })
        ]
      };
    }
  },

  fpl_get_entry_history: {
    description:
      'Get an FPL manager\'s season history: points, rank, squad value and transfers for every gameweek, plus past-season finishes and chips played. Use for rank-trajectory and chip-strategy questions about an entry_id (from fpl_get_entry or league standings).',
    parameters: {
      type: 'object',
      required: ['entry_id'],
      properties: {
        entry_id: { type: 'integer', description: 'FPL entry (team) id of the manager.' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'season history', plural: 'season histories' },
      title: 'Season history — entry {{entryId}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Total points', field: 'totalPoints' },
            { label: 'Current rank', field: 'currentRank' },
            { label: 'Best GW', field: 'bestGameweek' }
          ]
        },
        {
          component: 'Section',
          title: 'Gameweek by gameweek',
          layout: [
            {
              component: 'Table',
              columns: [
                { header: 'GW', field: 'event' },
                { header: 'Pts', field: 'points' },
                { header: 'Total', field: 'totalPoints' },
                { header: 'Rank', field: 'overallRank' },
                { header: 'Hit', field: 'transferCost' }
              ],
              rows: 'seasonRows'
            }
          ]
        },
        {
          component: 'Section',
          title: 'Chips & past seasons',
          layout: [
            { component: 'KeyValue', pairs: [{ label: 'Chips played', field: 'chipsPlayed' }] },
            {
              component: 'Table',
              columns: [
                { header: 'Season', field: 'season' },
                { header: 'Pts', field: 'totalPoints' },
                { header: 'Rank', field: 'rank' }
              ],
              rows: 'pastSeasons'
            }
          ]
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const entryId = requirePositiveInt(args?.entry_id, 'entry_id');
      const history = await fetchEntryHistory(entryId);
      const latest = history.current[history.current.length - 1];
      const best = history.current.reduce((a, b) => (b.points > (a?.points ?? -Infinity) ? b : a), history.current[0]);
      const rows = history.current.map((gw) => ({
        event: gw.event,
        points: gw.points,
        totalPoints: gw.total_points,
        overallRank: formatRank(gw.overall_rank),
        transferCost: gw.event_transfers_cost > 0 ? `-${gw.event_transfers_cost}` : '0',
        value: `£${(gw.value / 10).toFixed(1)}m`
      }));
      const pastSeasons = history.past.map((s) => ({ season: s.season_name, totalPoints: s.total_points, rank: formatRank(s.rank) }));
      const chips = history.chips.map((c) => `${chipLabel(c.name)} (GW${c.event})`).join(', ') || 'None';
      const lines = [
        `Entry ${entryId} season history (${history.current.length} gameweeks played).`,
        latest ? `Latest: Gameweek ${latest.event} — ${latest.points} pts, ${latest.total_points} total, overall rank ${formatRank(latest.overall_rank)}.` : '',
        best ? `Best gameweek: GW${best.event} with ${best.points} pts.` : '',
        `Chips played: ${chips}.`,
        pastSeasons.length
          ? `Past seasons: ${pastSeasons.map((s) => `${s.season} — ${s.totalPoints} pts, rank ${s.rank}`).join('; ')}.`
          : 'No past seasons on record.'
      ].filter(Boolean);
      return {
        text: lines.join('\n'),
        data: {
          entryId,
          totalPoints: latest?.total_points ?? 0,
          currentRank: latest ? formatRank(latest.overall_rank) : 'n/a',
          bestGameweek: best ? `GW${best.event} (${best.points} pts)` : 'n/a',
          seasonRows: rows,
          pastSeasons,
          chipsPlayed: chips
        },
        references: [
          createApiReference({
            id: `${entryId}-history`,
            label: `Entry ${entryId} — season history`,
            sourceUrl: `${BASE}/entry/${entryId}/history/`,
            quote: latest ? `GW${latest.event}: ${latest.points} pts, overall rank ${formatRank(latest.overall_rank)}` : 'No history yet.',
            payload: history
          })
        ]
      };
    }
  },

  fpl_get_entry_picks: {
    description:
      'Get an FPL manager\'s squad for one gameweek: starting XI, bench order, captain and vice-captain (resolved to player names), active chip, points scored and transfer cost. Entry ids come from fpl_get_entry or fpl_get_league_standings; gameweeks from fpl_get_game_overview.',
    parameters: {
      type: 'object',
      required: ['entry_id', 'event'],
      properties: {
        entry_id: { type: 'integer', description: 'FPL entry (team) id of the manager.' },
        event: { type: 'integer', description: 'Gameweek number (1-38) to fetch picks for.' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'gameweek squad', plural: 'gameweek squads' },
      title: 'GW{{gameweek}} squad — entry {{entryId}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'GW points', field: 'gameweekPoints' },
            { label: 'Overall rank', field: 'overallRank' },
            { label: 'Transfer hit', field: 'transferCost' }
          ]
        },
        { component: 'Badge', field: 'activeChip', tone: 'muted' },
        {
          component: 'Table',
          columns: [
            { header: 'Player', field: 'player' },
            { header: 'Role', field: 'role' },
            { header: 'Pos', field: 'position' },
            { header: 'Team', field: 'team' }
          ],
          rows: 'lineup'
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const entryId = requirePositiveInt(args?.entry_id, 'entry_id');
      const event = requirePositiveInt(args?.event, 'event');
      const [picksData, bootstrap] = await Promise.all([fetchEntryPicks(entryId, event), fetchBootstrapStatic()]);
      const lookups = buildLookups(bootstrap);
      const playerById = new Map(bootstrap.elements.map((p) => [p.id, p]));
      const lineup = picksData.picks.map((pick) => {
        const player = playerById.get(pick.element);
        const role = pick.is_captain ? 'Captain' : pick.is_vice_captain ? 'Vice-captain' : pick.position > 11 ? `Bench ${pick.position - 11}` : 'Starting XI';
        return {
          player: player ? playerLabel(player) : `Player ${pick.element}`,
          playerId: pick.element,
          role,
          position: player ? lookups.positionOf(player) : '?',
          team: player ? lookups.teamName(player.team) : '?',
          multiplier: pick.multiplier
        };
      });
      const captain = lineup.find((p) => p.role === 'Captain');
      const h = picksData.entry_history;
      const activeChip = chipLabel(picksData.active_chip);
      const lines = [
        `Entry ${entryId} — Gameweek ${event} squad (${picksData.picks.length} picks).`,
        `Points: ${h.points} (total ${h.total_points}), overall rank ${formatRank(h.overall_rank)}, transfer cost -${h.event_transfers_cost}.`,
        `Active chip: ${activeChip}. Captain: ${captain ? captain.player : 'none'}.`,
        ...lineup.map((p) => `${p.playerId}: ${p.player} — ${p.role} (${p.position}, ${p.team})`)
      ];
      return {
        text: lines.join('\n'),
        data: {
          entryId,
          gameweek: event,
          gameweekPoints: h.points,
          totalPoints: h.total_points,
          overallRank: formatRank(h.overall_rank),
          transferCost: h.event_transfers_cost > 0 ? `-${h.event_transfers_cost}` : '0',
          activeChip,
          captain: captain?.player ?? 'None',
          lineup
        },
        references: [
          createApiReference({
            id: `${entryId}-gw${event}-picks`,
            label: `Entry ${entryId} — GW${event} picks`,
            sourceUrl: `${BASE}/entry/${entryId}/event/${event}/picks/`,
            quote: `GW${event}: ${h.points} pts, captain ${captain?.player ?? 'none'}, chip ${activeChip}`,
            payload: picksData
          })
        ]
      };
    }
  },

  fpl_get_league_standings: {
    description:
      'Get the standings table for a classic FPL mini-league: rank, team name, manager, gameweek points and total points, 50 entries per page. Entry ids in the result feed fpl_get_entry, fpl_get_entry_history and fpl_get_entry_picks for head-to-head analysis.',
    parameters: {
      type: 'object',
      required: ['league_id'],
      properties: {
        league_id: { type: 'integer', description: 'Classic league id (the number in the league\'s FPL URL, or from fpl_get_entry\'s classic leagues).' },
        page: { type: 'integer', description: 'Standings page number (50 entries per page, default 1).' }
      },
      additionalProperties: false
    },
    card: {
      name: { singular: 'league table', plural: 'league tables' },
      title: '{{leagueName}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Entries shown', field: 'entriesShown' },
            { label: 'Page', field: 'page' },
            { label: 'Leader', field: 'leader' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: '#', field: 'rank' },
            { header: 'Team', field: 'team' },
            { header: 'Manager', field: 'manager' },
            { header: 'GW', field: 'gameweekPoints' },
            { header: 'Total', field: 'totalPoints' }
          ],
          rows: 'standings'
        }
      ]
    },
    async execute(args): Promise<ToolResult> {
      const leagueId = requirePositiveInt(args?.league_id, 'league_id');
      const page = requirePositiveInt(args?.page ?? 1, 'page');
      const data = await fetchClassicLeagueStandings(leagueId, { page });
      const rows = data.standings.results.map((r) => ({
        rank: r.rank,
        team: r.entry_name,
        manager: r.player_name,
        entryId: r.entry,
        gameweekPoints: r.event_total,
        totalPoints: r.total,
        lastRank: r.last_rank
      }));
      const leader = rows[0];
      const lines = [
        `${data.league.name} — classic league standings, page ${data.standings.page}${data.standings.has_next ? ' (more pages available)' : ''}.`,
        leader ? `Leader: ${leader.team} (${leader.manager}) on ${leader.totalPoints} pts.` : 'No entries on this page.',
        ...rows.map((r) => `${r.rank}. ${r.team} — ${r.manager}, entry ${r.entryId}, ${r.totalPoints} pts (GW ${r.gameweekPoints})`)
      ];
      return {
        text: lines.join('\n'),
        data: {
          leagueId,
          leagueName: data.league.name,
          page: data.standings.page,
          hasNext: data.standings.has_next,
          entriesShown: rows.length,
          leader: leader ? `${leader.team} (${leader.totalPoints} pts)` : 'n/a',
          standings: rows
        },
        references: [
          createApiReference({
            id: `league-${leagueId}-page-${page}`,
            label: `${data.league.name} — standings page ${page}`,
            sourceUrl: `${BASE}/leagues-classic/${leagueId}/standings/?page_standings=${page}`,
            quote: leader ? `${rows.length} entries; leader ${leader.team} on ${leader.totalPoints} pts.` : `${rows.length} entries.`,
            payload: data
          })
        ]
      };
    }
  }
});
