import { createApiReference, defineTools, requireCredential, requireNonEmpty, requirePositiveInt, type CardTemplate } from '@raynard/plugin-sdk';
import { BASE_URL, fetchTrendsByWoeid, fetchTweet, fetchUserByUsername, fetchUserTweets, searchRecentTweets, type XListResponse, type XTweet, type XUser } from './client.ts';

const credential = () => requireCredential('X_API_BEARER_TOKEN', 'X API bearer token / API key');
const tweetUrl = (id: string) => `https://x.com/i/web/status/${id}`;
const userUrl = (username: string) => `https://x.com/${username}`;
const metric = (v: unknown) => (typeof v === 'number' ? v : 0);

const COMMON_WOEIDS = new Map<number, string>([
  [1, 'Worldwide'],
  [23424977, 'United States'],
  [23424975, 'United Kingdom'],
  [23424856, 'Japan'],
  [2459115, 'New York'],
  [2442047, 'Los Angeles'],
  [44418, 'London'],
  [1118370, 'Tokyo'],
]);

function positiveLimit(value: unknown, label: string, defaultValue: number, min: number, max: number) {
  if (value === undefined || value === null || value === '') return defaultValue;
  const n = requirePositiveInt(value, label);
  if (n < min || n > max) throw new Error(`${label} must be between ${min} and ${max}.`);
  return n;
}

function usersById(users?: XUser[]) {
  return new Map((users ?? []).map((u) => [u.id, u]));
}

function tweetRow(tweet: XTweet, user?: XUser) {
  return {
    id: tweet.id,
    text: tweet.text,
    author_id: tweet.author_id ?? '',
    author: user?.username ? `@${user.username}` : tweet.author_id ?? '',
    author_name: user?.name ?? '',
    created_at: tweet.created_at ?? '',
    conversation_id: tweet.conversation_id ?? '',
    lang: tweet.lang ?? '',
    retweets: metric(tweet.public_metrics?.retweet_count),
    replies: metric(tweet.public_metrics?.reply_count),
    likes: metric(tweet.public_metrics?.like_count),
    quotes: metric(tweet.public_metrics?.quote_count),
    impressions: metric(tweet.public_metrics?.impression_count),
    url: tweetUrl(tweet.id),
  };
}

function listRows(response: XListResponse) {
  const byId = usersById(response.includes?.users);
  return (response.data ?? []).map((t) => tweetRow(t, t.author_id ? byId.get(t.author_id) : undefined));
}

function tweetReferences(tweets: XTweet[], users?: XUser[]) {
  const byId = usersById(users);
  return tweets.map((t) => {
    const user = t.author_id ? byId.get(t.author_id) : undefined;
    return createApiReference({ id: t.id, label: user?.username ? `@${user.username}: ${t.id}` : `Tweet ${t.id}`, sourceUrl: tweetUrl(t.id), quote: t.text, payload: { tweet: t, author: user } });
  });
}

const tweetListCard: CardTemplate = {
  name: { singular: 'post', plural: 'posts' },
  title: '{{title}}',
  layout: [
    { component: 'MetricRow', items: [{ label: 'Returned', field: 'count' }, { label: 'API total', field: 'result_count' }, { label: 'Next token', field: 'next_token', tone: 'muted' as const }] },
    { component: 'Table', rows: 'posts', columns: [
      { header: 'ID', field: 'id' }, { header: 'Author', field: 'author' }, { header: 'Text', field: 'text' }, { header: 'Likes', field: 'likes' }, { header: 'Replies', field: 'replies' }, { header: 'Conversation', field: 'conversation_id' }
    ] },
  ],
};

export const tools = defineTools({
  x_search_recent_posts: {
    description: 'Search public recent X posts using GET /2/tweets/search/recent. Use X recent-search query syntax in query; the API returns a recent matching page, not the full historical archive. max_results defaults to 10 and the API accepts 10-100. Use next_token from the result to fetch the next page. start_time and end_time are ISO 8601 UTC timestamps and only filter when included in the request. Results include public metrics, author expansion, conversation_id, and X status URLs; call x_get_post for a single post or search conversation_id:<id> to inspect a thread/conversation page permitted by your X API access tier.',
    parameters: { type: 'object', required: ['query'], properties: {
      query: { type: 'string', description: 'Required X recent search query, for example "from:XDevelopers has:links" or "conversation_id:1930000000000000000". X silently ignores unsupported operators depending on access tier.' },
      max_results: { type: 'integer', minimum: 10, maximum: 100, description: 'Page size. Defaults to 10; X recent search requires values from 10 through 100.' },
      next_token: { type: 'string', description: 'Opaque pagination token returned as meta.next_token by a previous recent-search call.' },
      start_time: { type: 'string', description: 'Optional ISO 8601 UTC lower bound, e.g. 2026-08-24T00:00:00Z. Must be within the recent-search window allowed by the API tier.' },
      end_time: { type: 'string', description: 'Optional ISO 8601 UTC upper bound, e.g. 2026-08-24T12:00:00Z.' },
    } },
    card: tweetListCard,
    async execute(args) {
      const query = requireNonEmpty(args?.query, 'query');
      const max_results = positiveLimit(args?.max_results, 'max_results', 10, 10, 100);
      const response = await searchRecentTweets({ query, max_results, next_token: args?.next_token ? String(args.next_token) : undefined, start_time: args?.start_time ? String(args.start_time) : undefined, end_time: args?.end_time ? String(args.end_time) : undefined, bearerToken: credential() });
      const posts = listRows(response);
      return { text: posts.length ? posts.map((p) => `${p.id} ${p.author}: ${p.text}`).join('\n') : `No recent X posts returned for query "${query}".`, data: { title: `Recent X search: ${query}`, query, count: posts.length, result_count: response.meta?.result_count ?? posts.length, next_token: response.meta?.next_token ?? '', posts, raw: response }, references: tweetReferences(response.data ?? [], response.includes?.users) };
    },
  },

  x_get_conversation_posts: {
    description: 'Fetch a recent-search page for one X conversation/thread using query conversation_id:<conversation_id> against GET /2/tweets/search/recent. conversation_id is usually the root post ID returned on each post. max_results defaults to 10 and must be 10-100; use next_token to page. This returns posts in the conversation that are visible to recent search and permitted by your X API tier, with public metrics and author expansions.',
    parameters: { type: 'object', required: ['conversation_id'], properties: {
      conversation_id: { type: 'string', description: 'Numeric X conversation_id, often the root post/tweet ID. Pass only the ID, not conversation_id:<id>.' },
      max_results: { type: 'integer', minimum: 10, maximum: 100, description: 'Page size for the recent-search conversation query. Defaults to 10; valid range is 10-100.' },
      next_token: { type: 'string', description: 'Opaque meta.next_token from a previous call for the same conversation_id.' },
    } },
    card: tweetListCard,
    async execute(args) {
      const conversation_id = requireNonEmpty(args?.conversation_id, 'conversation_id');
      const max_results = positiveLimit(args?.max_results, 'max_results', 10, 10, 100);
      const query = `conversation_id:${conversation_id}`;
      const response = await searchRecentTweets({ query, max_results, next_token: args?.next_token ? String(args.next_token) : undefined, bearerToken: credential() });
      const posts = listRows(response);
      return { text: posts.length ? posts.map((p) => `${p.id} ${p.author}: ${p.text}`).join('\n') : `No recent X posts returned for conversation ${conversation_id}.`, data: { title: `X conversation ${conversation_id}`, conversation_id, query, count: posts.length, result_count: response.meta?.result_count ?? posts.length, next_token: response.meta?.next_token ?? '', posts, raw: response }, references: tweetReferences(response.data ?? [], response.includes?.users) };
    },
  },

  x_get_post: {
    description: 'Retrieve one public X post by numeric tweet/post ID using GET /2/tweets/:id. Returns text, author expansion, conversation_id for thread lookup, referenced tweet IDs, and public engagement metrics. Use IDs found from x_search_recent_posts or x_get_user_posts; use x_search_recent_posts with query conversation_id:<conversation_id> for conversation/thread pages permitted by the API tier.',
    parameters: { type: 'object', required: ['id'], properties: { id: { type: 'string', description: 'Numeric X post/tweet ID from the API, URL, or a previous tool result. Do not pass a full URL.' } } },
    card: { name: { singular: 'post', plural: 'posts' }, title: 'X post {{id}}', layout: [
      { component: 'Text', text: '{{text}}' },
      { component: 'MetricRow', items: [{ label: 'Likes', field: 'likes' }, { label: 'Replies', field: 'replies' }, { label: 'Retweets', field: 'retweets' }, { label: 'Quotes', field: 'quotes' }] },
      { component: 'KeyValue', pairs: [{ label: 'Author', field: 'author' }, { label: 'Created', field: 'created_at' }, { label: 'Conversation', field: 'conversation_id' }, { label: 'URL', field: 'url' }] },
      { component: 'Json', field: 'raw' },
    ] },
    async execute(args) {
      const id = requireNonEmpty(args?.id, 'id');
      const response = await fetchTweet({ id, bearerToken: credential() });
      if (!response.data) throw new Error(`X post ${id} was not returned by the API.`);
      const author = response.data.author_id ? usersById(response.includes?.users).get(response.data.author_id) : undefined;
      const row = tweetRow(response.data, author);
      return { text: `${row.id} ${row.author}: ${row.text}`, data: { ...row, raw: response }, references: tweetReferences([response.data], response.includes?.users) };
    },
  },

  x_get_user_by_username: {
    description: 'Look up a public X account by username using GET /2/users/by/username/:username. Returns account ID needed for x_get_user_posts, display name, bio/location/url where public, verification flag, created_at, profile image URL, and public account metrics.',
    parameters: { type: 'object', required: ['username'], properties: { username: { type: 'string', description: 'X handle with or without leading @, for example XDevelopers. The API path uses the username, not the numeric user ID.' } } },
    card: { name: { singular: 'user', plural: 'users' }, title: '@{{username}} — {{name}}', layout: [
      { component: 'Image', field: 'profile_image_url', alt: 'Profile image', variant: 'avatar' },
      { component: 'Text', text: '{{description}}' },
      { component: 'MetricRow', items: [{ label: 'Followers', field: 'followers' }, { label: 'Following', field: 'following' }, { label: 'Posts', field: 'tweet_count' }, { label: 'Listed', field: 'listed' }] },
      { component: 'KeyValue', pairs: [{ label: 'ID', field: 'id' }, { label: 'Verified', field: 'verified' }, { label: 'Location', field: 'location' }, { label: 'Joined', field: 'created_at' }, { label: 'URL', field: 'url' }] },
    ] },
    async execute(args) {
      const username = requireNonEmpty(args?.username, 'username').replace(/^@/, '');
      const response = await fetchUserByUsername({ username, bearerToken: credential() });
      if (!response.data) throw new Error(`X user @${username} was not returned by the API.`);
      const u = response.data;
      const data = { id: u.id, name: u.name, username: u.username, verified: Boolean(u.verified), description: u.description ?? '', location: u.location ?? '', created_at: u.created_at ?? '', url: userUrl(u.username), profile_image_url: u.profile_image_url ?? '', followers: metric(u.public_metrics?.followers_count), following: metric(u.public_metrics?.following_count), tweet_count: metric(u.public_metrics?.tweet_count), listed: metric(u.public_metrics?.listed_count), raw: response };
      return { text: `@${u.username} (${u.id}): ${u.name}${u.description ? ` — ${u.description}` : ''}`, data, references: [createApiReference({ id: u.id, label: `@${u.username}`, sourceUrl: userUrl(u.username), quote: `${u.name}: ${u.description ?? ''}`, payload: response })] };
    },
  },

  x_get_user_posts: {
    description: 'List recent public posts authored by a numeric X user ID using GET /2/users/:id/tweets. Use x_get_user_by_username first when you only have a handle. max_results defaults to 10 and this endpoint accepts 5-100. pagination_token must be the opaque meta.next_token returned by this same endpoint. exclude can omit replies, retweets, or both; start_time/end_time are ISO 8601 UTC filters honored when allowed by your API access tier.',
    parameters: { type: 'object', required: ['id'], properties: {
      id: { type: 'string', description: 'Numeric X user/account ID, not a @username. Get it from x_get_user_by_username.' },
      max_results: { type: 'integer', minimum: 5, maximum: 100, description: 'Page size. Defaults to 10; X user timelines accept 5 through 100.' },
      pagination_token: { type: 'string', description: 'Opaque meta.next_token from a previous x_get_user_posts response for the same user and filters.' },
      exclude: { type: 'string', enum: ['replies', 'retweets', 'replies,retweets'], description: 'Optional comma-separated exclusion. Use replies, retweets, or replies,retweets exactly.' },
      start_time: { type: 'string', description: 'Optional ISO 8601 UTC lower bound for returned posts.' },
      end_time: { type: 'string', description: 'Optional ISO 8601 UTC upper bound for returned posts.' },
    } },
    card: tweetListCard,
    async execute(args) {
      const id = requireNonEmpty(args?.id, 'id');
      const max_results = positiveLimit(args?.max_results, 'max_results', 10, 5, 100);
      const response = await fetchUserTweets({ id, max_results, pagination_token: args?.pagination_token ? String(args.pagination_token) : undefined, exclude: args?.exclude ? String(args.exclude) : undefined, start_time: args?.start_time ? String(args.start_time) : undefined, end_time: args?.end_time ? String(args.end_time) : undefined, bearerToken: credential() });
      const posts = listRows(response);
      return { text: posts.length ? posts.map((p) => `${p.id} ${p.author}: ${p.text}`).join('\n') : `No public posts returned for X user ID ${id}.`, data: { title: `X user ${id} posts`, user_id: id, count: posts.length, result_count: response.meta?.result_count ?? posts.length, next_token: response.meta?.next_token ?? '', posts, raw: response }, references: tweetReferences(response.data ?? [], response.includes?.users) };
    },
  },

  x_get_trends_by_location: {
    description: 'Get the current X trending topics for one supported geographic location using GET /2/trends/by/woeid/:woeid. The location is identified by a Yahoo! Where On Earth ID (WOEID). Common official IDs are Worldwide 1, United States 23424977, United Kingdom 23424975, Japan 23424856, New York 2459115, Los Angeles 2442047, London 44418, and Tokyo 1118370. Results are returned in X trend order, max_trends defaults to 20 and accepts 1-50, and tweet_count can be absent for a topic. The app-only bearer-token limit documented by X is 75 requests per 15 minutes.',
    parameters: { type: 'object', required: ['woeid'], properties: {
      woeid: { type: 'integer', minimum: 1, maximum: 2147483647, description: 'Positive 32-bit Yahoo WOEID for the requested location. Common values: Worldwide 1; United States 23424977; United Kingdom 23424975; Japan 23424856; New York 2459115; Los Angeles 2442047; London 44418; Tokyo 1118370.' },
      max_trends: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum current trends to return. Defaults to 20; the X API accepts 1 through 50.' },
    } },
    card: { name: { singular: 'trend', plural: 'trends' }, title: 'Trending on X — {{location}}', layout: [
      { component: 'MetricRow', items: [{ label: 'Returned', field: 'count' }, { label: 'WOEID', field: 'woeid', tone: 'muted' as const }] },
      { component: 'Table', rows: 'trends', columns: [
        { header: '#', field: 'rank' }, { header: 'Topic', field: 'trend_name' }, { header: 'Posts', field: 'tweet_count' }
      ] },
    ] },
    async execute(args) {
      const woeid = requirePositiveInt(args?.woeid, 'woeid');
      if (woeid > 2147483647) throw new Error('woeid must be a positive 32-bit integer.');
      const max_trends = positiveLimit(args?.max_trends, 'max_trends', 20, 1, 50);
      const response = await fetchTrendsByWoeid({ woeid, max_trends, bearerToken: credential() });
      const location = COMMON_WOEIDS.get(woeid) ?? `WOEID ${woeid}`;
      const trends = (response.data ?? []).map((trend, index) => ({
        rank: index + 1,
        trend_name: trend.trend_name,
        tweet_count: typeof trend.tweet_count === 'number' ? trend.tweet_count : '',
        url: `https://x.com/search?q=${encodeURIComponent(trend.trend_name)}&src=typed_query`,
      }));
      return {
        text: trends.length
          ? `Current X trends for ${location}:\n${trends.map((trend) => `${trend.rank}. ${trend.trend_name}${trend.tweet_count === '' ? '' : ` — ${trend.tweet_count} posts`}`).join('\n')}`
          : `No current X trends were returned for ${location} (WOEID ${woeid}).`,
        data: { title: `Trending on X — ${location}`, location, woeid, count: trends.length, trends, raw: response },
        references: trends.map((trend, index) => createApiReference({
          id: `trend-${woeid}-${index + 1}`,
          label: `${location}: ${trend.trend_name}`,
          sourceUrl: trend.url,
          quote: `${trend.trend_name}${trend.tweet_count === '' ? '' : ` — ${trend.tweet_count} posts`}`,
          payload: { woeid, location, trend: response.data?.[index] },
        })),
      };
    },
  },
});
