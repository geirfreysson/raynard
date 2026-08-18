// Tool registry for the official Hacker News API (https://github.com/hackernews/api).
// Every tool returns text, citations, matching data, and one fixed card.
import {
  API_BASE,
  fetchTopStoryIds,
  fetchNewStoryIds,
  fetchBestStoryIds,
  fetchAskStoryIds,
  fetchShowStoryIds,
  fetchJobStoryIds,
  fetchItem,
  fetchItems,
  fetchUser,
  fetchMaxItemId,
  fetchUpdates
} from './client.ts';
import type { HnItem, HnUser, HnUpdates } from './client.ts';
import {
  createApiReference,
  defineCard,
  defineTools,
  requireNonEmpty,
  requirePositiveInt,
  type ApiTool,
  type ToolResult
} from '@raynard/plugin-sdk';

// ---------------------------------------------------------------------------
// Shared rendering helpers
// ---------------------------------------------------------------------------

/** Convert the API's HTML-ish text fields to a single-line plain-text snippet. */
function htmlToText(html?: string, max = 240): string {
  if (!html) return '';
  let text = html
    .replace(/<a[^>]*href="([^"]*)"[^>]*>[\s\S]*?<\/a>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => String.fromCodePoint(parseInt(String(hex), 16)))
    .replace(/&#(\d+);/g, (_m, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > max) text = text.slice(0, max - 1).trimEnd() + '…';
  return text;
}

const isoDate = (unixSeconds?: number): string =>
  unixSeconds ? new Date(unixSeconds * 1000).toISOString() : 'unknown';

/** Clamp an optional integer limit argument into [min, max]. */
function clampLimit(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(numeric)));
}

const commentCount = (item: HnItem): number => item.descendants ?? item.kids?.length ?? 0;

const itemPageUrl = (id: number): string => `https://news.ycombinator.com/item?id=${id}`;

const itemLabel = (item: HnItem): string =>
  item.title ? htmlToText(item.title, 120) : `${item.type ?? 'item'} #${item.id}`;

/** One-line rendering used by the feed list tools and the search tool. */
function storyLine(item: HnItem, rank: number): string {
  const link = item.url ?? itemPageUrl(item.id);
  return (
    `${rank}. [${item.type ?? 'item'}] "${itemLabel(item)}" #${item.id} — ` +
    `${item.score ?? 0} points by ${item.by ?? 'unknown'} — ${commentCount(item)} comments — ` +
    `${link} — posted ${isoDate(item.time)}`
  );
}

function itemReference(item: HnItem) {
  const quote = item.title
    ? `[${item.type ?? 'item'}] "${itemLabel(item)}" — ${item.score ?? 0} points, ${commentCount(item)} comments, by ${item.by ?? 'unknown'}`
    : htmlToText(item.text, 200) || `${item.type ?? 'item'} #${item.id}`;
  return createApiReference({
    id: String(item.id),
    label: itemLabel(item),
    sourceUrl: `${API_BASE}/item/${item.id}.json`,
    quote,
    payload: item
  });
}

function userReference(user: HnUser) {
  return createApiReference({
    id: user.id,
    label: `u/${user.id}`,
    sourceUrl: `${API_BASE}/user/${encodeURIComponent(user.id)}.json`,
    quote: `karma ${user.karma ?? 0}, ${user.submitted?.length ?? 0} submissions, member since ${isoDate(user.created)}`,
    payload: user
  });
}

// ---------------------------------------------------------------------------
// Story feeds
// ---------------------------------------------------------------------------

const FEEDS = {
  top: {
    label: 'top stories',
    fetchIds: fetchTopStoryIds,
    blurb: 'the current front-page ranking on Hacker News'
  },
  new: {
    label: 'newest stories',
    fetchIds: fetchNewStoryIds,
    blurb: 'the most recently submitted stories on Hacker News'
  },
  best: {
    label: 'best stories',
    fetchIds: fetchBestStoryIds,
    blurb: 'the highest-voted recent stories on Hacker News'
  },
  ask: {
    label: 'Ask HN stories',
    fetchIds: fetchAskStoryIds,
    blurb: 'the latest "Ask HN" question posts on Hacker News'
  },
  show: {
    label: 'Show HN stories',
    fetchIds: fetchShowStoryIds,
    blurb: 'the latest "Show HN" project posts on Hacker News'
  },
  job: {
    label: 'job postings',
    fetchIds: fetchJobStoryIds,
    blurb: 'the latest job postings on Hacker News (who is hiring)'
  }
} as const;

type FeedKey = keyof typeof FEEDS;

const limitParameter = {
  type: 'integer',
  description: 'How many stories to return (1-30, default 10). The feed is scanned from the top.',
  minimum: 1,
  maximum: 30
};

function makeFeedTool(feed: FeedKey, toolName: string): ApiTool {
  const { label, fetchIds, blurb } = FEEDS[feed];
  return {
    description:
      `List ${label} from the official Hacker News API — ${blurb}. ` +
      `Fetches the /v0/${feed === 'top' ? 'topstories' : feed === 'new' ? 'newstories' : feed === 'best' ? 'beststories' : feed === 'ask' ? 'askstories' : feed === 'show' ? 'showstories' : 'jobstories'}.json id feed and then each story item. ` +
      `Optional limit (1-30, default 10). Returns each story's id, title, score, author and comment count; ` +
      `drill into one with hn_get_item, read its discussion with hn_get_item_comments, or filter by keyword/type/time with hn_search_stories.`,
    parameters: {
      type: 'object',
      properties: { limit: limitParameter }
    },
    card: defineCard({
      name: { singular: 'story', plural: 'stories' },
      title: `${label[0].toUpperCase()}${label.slice(1)}`,
      layout: [
        { component: 'MetricRow', items: [{ label: 'Stories', field: 'count' }] },
        {
          component: 'Table',
          columns: [
            { header: 'ID', field: 'id' },
            { header: 'Title', field: 'title' },
            { header: 'Score', field: 'score' },
            { header: 'Comments', field: 'comments' },
            { header: 'Author', field: 'author' }
          ],
          rows: 'stories'
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const limit = clampLimit(args?.limit, 10, 1, 30);
      const ids = await fetchIds();
      const stories = await fetchItems(ids.slice(0, limit));
      const header = `${label[0].toUpperCase()}${label.slice(1)} on Hacker News (showing ${stories.length}):`;
      return {
        text: [header, ...stories.map((story, index) => storyLine(story, index + 1))].join('\n'),
        data: {
          count: stories.length,
          stories: stories.map((story) => ({
            id: story.id,
            title: story.title ?? '(untitled)',
            score: story.score ?? 0,
            comments: story.descendants ?? 0,
            author: story.by ?? 'unknown'
          }))
        },
        references: stories.map((story) => itemReference(story))
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const tools = defineTools({
  hn_list_top_stories: makeFeedTool('top', 'hn_list_top_stories'),
  hn_list_new_stories: makeFeedTool('new', 'hn_list_new_stories'),
  hn_list_best_stories: makeFeedTool('best', 'hn_list_best_stories'),
  hn_list_ask_stories: makeFeedTool('ask', 'hn_list_ask_stories'),
  hn_list_show_stories: makeFeedTool('show', 'hn_list_show_stories'),
  hn_list_job_stories: makeFeedTool('job', 'hn_list_job_stories'),

  hn_search_stories: {
    description:
      'Search and filter Hacker News stories fetched from a live feed (top, new, best, ask, show or job). ' +
      'The official API has no server-side search, so this tool scans up to scanLimit recent feed items (default 100, max 500) ' +
      'and filters client-side by keyword (title, author, URL or text), item type (story/job/poll), and time period ' +
      '(period enum, or an explicit minTime/maxTime Unix-second window). ' +
      'Returns matching story ids, titles, scores and dates — use hn_get_item for full details on a match.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Optional case-insensitive keyword matched against the story title, author, URL and text.'
        },
        feed: {
          type: 'string',
          enum: ['top', 'new', 'best', 'ask', 'show', 'job'],
          description: 'Which story feed to scan (default "new"; "new" covers the freshest submissions).'
        },
        type: {
          type: 'string',
          enum: ['story', 'job', 'poll'],
          description: 'Optional item type filter. Omit to include every type in the feed.'
        },
        period: {
          type: 'string',
          enum: ['hour', 'day', 'week', 'month'],
          description: 'Optional recency filter: only include items posted within the last hour, day, week or month.'
        },
        minTime: {
          type: 'integer',
          description: 'Optional minimum creation time as Unix seconds (inclusive). Combined with period, the stricter bound wins.'
        },
        maxTime: {
          type: 'integer',
          description: 'Optional maximum creation time as Unix seconds (inclusive).'
        },
        limit: {
          type: 'integer',
          description: 'Maximum matches to return (1-30, default 10).',
          minimum: 1,
          maximum: 30
        },
        scanLimit: {
          type: 'integer',
          description: 'How many feed items to scan before filtering (10-500, default 100). Raise it to search deeper back in time.',
          minimum: 10,
          maximum: 500
        }
      }
    },
    card: defineCard({
      name: { singular: 'story', plural: 'stories' },
      title: 'Hacker News search — {{feed}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Matches', field: 'matchCount' },
            { label: 'Shown', field: 'shownCount' },
            { label: 'Scanned', field: 'scannedCount' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: 'ID', field: 'id' },
            { header: 'Title', field: 'title' },
            { header: 'Score', field: 'score' },
            { header: 'Comments', field: 'comments' },
            { header: 'Date', field: 'date' }
          ],
          rows: 'stories'
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const feedKey = String(args?.feed ?? 'new');
      if (!(feedKey in FEEDS)) {
        throw new Error(`feed must be one of: ${Object.keys(FEEDS).join(', ')}. Received: ${feedKey}`);
      }
      const feed = FEEDS[feedKey as FeedKey];
      const query = String(args?.query ?? '').trim().toLowerCase();
      const type = args?.type ? String(args.type) : '';
      if (type && !['story', 'job', 'poll'].includes(type)) {
        throw new Error(`type must be one of: story, job, poll. Received: ${type}`);
      }
      const limit = clampLimit(args?.limit, 10, 1, 30);
      const scanLimit = clampLimit(args?.scanLimit, 100, 10, 500);

      const PERIOD_SECONDS: Record<string, number> = {
        hour: 3600,
        day: 86400,
        week: 604800,
        month: 2592000
      };
      let minTime = args?.minTime !== undefined ? Number(args.minTime) : undefined;
      const period = args?.period ? String(args.period) : '';
      if (period) {
        const seconds = PERIOD_SECONDS[period];
        if (!seconds) {
          throw new Error(`period must be one of: ${Object.keys(PERIOD_SECONDS).join(', ')}. Received: ${period}`);
        }
        const periodFloor = Math.floor(Date.now() / 1000) - seconds;
        minTime = minTime === undefined ? periodFloor : Math.max(minTime, periodFloor);
      }
      const maxTime = args?.maxTime !== undefined ? Number(args.maxTime) : undefined;

      const ids = await feed.fetchIds();
      const scanned = await fetchItems(ids.slice(0, scanLimit));
      const matches = scanned.filter((item) => {
        if (item.dead) return false;
        if (type && item.type !== type) return false;
        if (minTime !== undefined && (item.time ?? 0) < minTime) return false;
        if (maxTime !== undefined && (item.time ?? Infinity) > maxTime) return false;
        if (query) {
          const haystack = [item.title, item.by, item.url, item.text]
            .filter(Boolean)
            .join('\n')
            .toLowerCase();
          if (!haystack.includes(query)) return false;
        }
        return true;
      });
      const shown = matches.slice(0, limit);
      const filters = [
        query ? `keyword "${query}"` : '',
        type ? `type ${type}` : '',
        period ? `last ${period}` : '',
        minTime !== undefined ? `after ${isoDate(minTime)}` : '',
        maxTime !== undefined ? `before ${isoDate(maxTime)}` : ''
      ].filter(Boolean);
      const header =
        `Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in ${feed.label}` +
        (filters.length ? ` (${filters.join(', ')})` : '') +
        ` after scanning ${scanned.length} items — showing ${shown.length}:`;
      return {
        text: [header, ...shown.map((story, index) => storyLine(story, index + 1))].join('\n'),
        data: {
          feed: feed.label,
          matchCount: matches.length,
          shownCount: shown.length,
          scannedCount: scanned.length,
          stories: shown.map((story) => ({
            id: story.id,
            title: story.title ?? '(untitled)',
            score: story.score ?? 0,
            comments: story.descendants ?? 0,
            date: isoDate(story.time)
          }))
        },
        references: shown.map((story) => itemReference(story))
      };
    }
  },

  hn_get_item: {
    description:
      'Fetch one Hacker News item by its numeric id — works for stories, comments, jobs, polls and poll options. ' +
      'Returns the title or text, type, author, score, comment count, URL, parent link and posting time, plus a result card. ' +
      'Use ids from hn_list_* or hn_search_stories; follow up with hn_get_item_comments for the discussion or hn_get_user for the author.',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'integer',
          description: 'The item id, e.g. 8863. Visible in HN URLs like news.ycombinator.com/item?id=8863.',
          minimum: 1
        }
      }
    },
    card: defineCard({
      name: { singular: 'item', plural: 'items' },
      title: '{{title}}',
      layout: [
        { component: 'Badge', field: 'type', tone: 'muted' },
        {
          component: 'MetricRow',
          items: [
            { label: 'Score', field: 'score' },
            { label: 'Comments', field: 'comments' }
          ]
        },
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Author', field: 'by' },
            { label: 'Posted', field: 'posted' },
            { label: 'Link', field: 'url' },
            { label: 'Item id', field: 'id' }
          ]
        },
        { component: 'Text', text: '{{snippet}}' }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const id = requirePositiveInt(args?.id, 'id');
      const item = await fetchItem(id);
      if (!item) throw new Error(`Item ${id} not found (deleted or does not exist).`);
      const title = itemLabel(item);
      const snippet = htmlToText(item.text) || htmlToText(item.title);
      const lines: string[] = [];
      if (item.type === 'comment') {
        lines.push(
          `#${item.id} comment by ${item.by ?? 'unknown'} — parent #${item.parent ?? 'unknown'} — posted ${isoDate(item.time)}`
        );
        if (snippet) lines.push(`"${snippet}"`);
      } else {
        lines.push(
          `#${item.id} "${title}" (${item.type ?? 'item'}) — ${item.score ?? 0} points by ${item.by ?? 'unknown'} — ` +
            `${commentCount(item)} comments — posted ${isoDate(item.time)}`
        );
        lines.push(`Link: ${item.url ?? itemPageUrl(item.id)}`);
        if (item.parent) lines.push(`Parent: #${item.parent}`);
        if (snippet && snippet !== title) lines.push(`Text: ${snippet}`);
        lines.push(`Discussion: ${itemPageUrl(item.id)}`);
      }
      return {
        text: lines.join('\n'),
        data: {
          id: item.id,
          type: item.type ?? 'item',
          title,
          by: item.by ?? 'unknown',
          score: item.score ?? 0,
          comments: commentCount(item),
          url: item.url ?? itemPageUrl(item.id),
          posted: isoDate(item.time),
          snippet
        },
        references: [itemReference(item)]
      };
    }
  },

  hn_get_item_comments: {
    description:
      'Fetch the top-level comments of a Hacker News story, poll or comment by id. ' +
      'Returns each direct reply with its id, author and plain-text body (HTML stripped), plus a result card with a comments table. ' +
      'Optional limit (1-30, default 10). Use hn_get_item on a comment id to follow its own replies (kids).',
    parameters: {
      type: 'object',
      required: ['id'],
      properties: {
        id: {
          type: 'integer',
          description: 'Id of the story, poll or comment whose direct replies you want.',
          minimum: 1
        },
        limit: {
          type: 'integer',
          description: 'How many top-level comments to return (1-30, default 10).',
          minimum: 1,
          maximum: 30
        }
      }
    },
    card: defineCard({
      name: { singular: 'discussion', plural: 'discussions' },
      title: 'Comments — {{title}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Total comments', field: 'total' },
            { label: 'Shown', field: 'shown' }
          ]
        },
        {
          component: 'Table',
          columns: [
            { header: 'Author', field: 'author' },
            { header: 'Comment', field: 'text' }
          ],
          rows: 'comments'
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const id = requirePositiveInt(args?.id, 'id');
      const limit = clampLimit(args?.limit, 10, 1, 30);
      const parent = await fetchItem(id);
      if (!parent) throw new Error(`Item ${id} not found (deleted or does not exist).`);
      const title = itemLabel(parent);
      const kidIds = (parent.kids ?? []).slice(0, limit);
      const comments = await fetchItems(kidIds);
      const rows = comments.map((comment) => ({
        id: comment.id,
        author: comment.by ?? 'unknown',
        text: htmlToText(comment.text),
        posted: isoDate(comment.time)
      }));
      const total = parent.descendants ?? parent.kids?.length ?? 0;
      const header = rows.length
        ? `Comments on "${title}" — ${total} total, showing ${rows.length} top-level:`
        : `Comments on "${title}" — no comments yet.`;
      const lines = rows.map((row) => `#${row.id} ${row.author}: ${row.text}`);
      return {
        text: [header, ...lines].join('\n'),
        data: { id: parent.id, title, total, shown: rows.length, comments: rows },
        references: [itemReference(parent), ...comments.map((comment) => itemReference(comment))]
      };
    }
  },

  hn_get_user: {
    description:
      'Fetch a Hacker News user profile by exact case-sensitive username. ' +
      'Returns karma, account creation date, the about text (HTML stripped) and total submission count, plus a result card. ' +
      'Use author names returned by hn_list_*, hn_search_stories or hn_get_item.',
    parameters: {
      type: 'object',
      required: ['username'],
      properties: {
        username: {
          type: 'string',
          description: 'Exact case-sensitive HN username, e.g. "pg".',
          minLength: 1
        }
      }
    },
    card: defineCard({
      name: { singular: 'profile', plural: 'profiles' },
      title: 'u/{{id}}',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Karma', field: 'karma' },
            { label: 'Submissions', field: 'submittedCount' }
          ]
        },
        {
          component: 'KeyValue',
          pairs: [
            { label: 'Created', field: 'created' },
            { label: 'About', field: 'about' }
          ]
        }
      ]
    }),
    async execute(args: Record<string, unknown>): Promise<ToolResult> {
      const username = requireNonEmpty(args?.username, 'username');
      const user = await fetchUser(username);
      if (!user) throw new Error(`User "${username}" not found.`);
      const about = htmlToText(user.about);
      const lines = [
        `User ${user.id} — karma ${user.karma ?? 0} — created ${isoDate(user.created)} — ${user.submitted?.length ?? 0} submissions`,
        about ? `About: ${about}` : 'About: (none)',
        `Profile: https://news.ycombinator.com/user?id=${encodeURIComponent(user.id)}`
      ];
      return {
        text: lines.join('\n'),
        data: {
          id: user.id,
          karma: user.karma ?? 0,
          created: isoDate(user.created),
          about: about || '(none)',
          submittedCount: user.submitted?.length ?? 0
        },
        references: [userReference(user)]
      };
    }
  },

  hn_get_max_item: {
    description:
      'Get the current largest Hacker News item id from /v0/maxitem.json — a cheap activity heartbeat for the whole site. ' +
      'Every new story, comment, job or poll increments it, so it doubles as a "how busy is HN right now" metric. ' +
      'Use hn_get_item on nearby ids to inspect the newest content, or hn_get_live_updates for what changed.',
    parameters: { type: 'object', properties: {} },
    card: defineCard({
      name: { singular: 'activity snapshot', plural: 'activity snapshots' },
      title: 'Hacker News activity heartbeat',
      layout: [
        { component: 'MetricRow', items: [{ label: 'Max item id', field: 'maxItemId' }] },
        {
          component: 'Text',
          text: 'Largest item id ever assigned — grows with every new story, comment, job and poll.'
        }
      ]
    }),
    async execute(): Promise<ToolResult> {
      const maxItemId = await fetchMaxItemId();
      return {
        text:
          `Current largest Hacker News item id: ${maxItemId}. ` +
          `Every new story, comment, job or poll gets the next id, so this is a live activity heartbeat.`,
        data: { maxItemId },
        references: [
          createApiReference({
            id: 'maxitem',
            label: 'HN max item id',
            sourceUrl: `${API_BASE}/maxitem.json`,
            quote: `The current largest item id is ${maxItemId}.`,
            payload: { maxItemId }
          })
        ]
      };
    }
  },

  hn_get_live_updates: {
    description:
      'Get the Hacker News live updates feed from /v0/updates.json: the item ids and profile names that changed most recently. ' +
      'Returns both counts and the raw id lists, plus a result card. ' +
      'Drill into changed items with hn_get_item and changed profiles with hn_get_user.',
    parameters: { type: 'object', properties: {} },
    card: defineCard({
      name: { singular: 'live update', plural: 'live updates' },
      title: 'Hacker News live updates',
      layout: [
        {
          component: 'MetricRow',
          items: [
            { label: 'Items changed', field: 'itemsChanged' },
            { label: 'Profiles changed', field: 'profilesChanged' }
          ]
        },
        { component: 'Json', field: 'itemIds' },
        { component: 'Json', field: 'profiles' }
      ]
    }),
    async execute(): Promise<ToolResult> {
      const updates: HnUpdates = await fetchUpdates();
      const itemIds = updates.items ?? [];
      const profiles = updates.profiles ?? [];
      const lines = [
        `Live updates: ${itemIds.length} items and ${profiles.length} profiles changed recently.`,
        itemIds.length ? `Changed items: ${itemIds.join(', ')}` : 'Changed items: none',
        profiles.length ? `Changed profiles: ${profiles.join(', ')}` : 'Changed profiles: none'
      ];
      return {
        text: lines.join('\n'),
        data: {
          itemsChanged: itemIds.length,
          profilesChanged: profiles.length,
          itemIds,
          profiles
        },
        references: [
          createApiReference({
            id: 'updates',
            label: 'HN live updates',
            sourceUrl: `${API_BASE}/updates.json`,
            quote: `${itemIds.length} items and ${profiles.length} profiles changed recently.`,
            payload: updates
          })
        ]
      };
    }
  }
});
