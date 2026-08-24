import { apiGet } from '@raynard/plugin-sdk';

export const BASE_URL = 'https://api.x.com/2';

export const TWEET_FIELDS = 'id,text,author_id,created_at,public_metrics,conversation_id,lang,source,referenced_tweets';
export const USER_FIELDS = 'id,name,username,verified,public_metrics,description,location,url,created_at,profile_image_url';
export const TWEET_EXPANSIONS = 'author_id,referenced_tweets.id,referenced_tweets.id.author_id';

export type XPublicMetrics = {
  retweet_count?: number;
  reply_count?: number;
  like_count?: number;
  quote_count?: number;
  impression_count?: number;
  followers_count?: number;
  following_count?: number;
  tweet_count?: number;
  listed_count?: number;
};

export type XTweet = {
  id: string;
  text: string;
  author_id?: string;
  created_at?: string;
  conversation_id?: string;
  lang?: string;
  source?: string;
  public_metrics?: XPublicMetrics;
  referenced_tweets?: { type: string; id: string }[];
};

export type XUser = {
  id: string;
  name: string;
  username: string;
  verified?: boolean;
  description?: string;
  location?: string;
  url?: string;
  created_at?: string;
  profile_image_url?: string;
  public_metrics?: XPublicMetrics;
};

export type XIncludes = { users?: XUser[]; tweets?: XTweet[] };
export type XMeta = { result_count?: number; newest_id?: string; oldest_id?: string; next_token?: string };
export type XListResponse = { data?: XTweet[]; includes?: XIncludes; meta?: XMeta; errors?: unknown[] };
export type XTweetResponse = { data?: XTweet; includes?: XIncludes; errors?: unknown[] };
export type XUserResponse = { data?: XUser; includes?: XIncludes; errors?: unknown[] };
export type XTrend = { trend_name: string; tweet_count?: number };
export type XTrendsResponse = { data?: XTrend[]; errors?: unknown[] };

const authHeaders = (bearerToken: string) => ({ Authorization: `Bearer ${bearerToken}` });

export function searchRecentTweets(args: { query: string; bearerToken: string; max_results?: number; next_token?: string; start_time?: string; end_time?: string }): Promise<XListResponse> {
  return apiGet<XListResponse>(`${BASE_URL}/tweets/search/recent`, {
    headers: authHeaders(args.bearerToken),
    query: {
      query: args.query,
      max_results: args.max_results,
      next_token: args.next_token,
      start_time: args.start_time,
      end_time: args.end_time,
      'tweet.fields': TWEET_FIELDS,
      expansions: TWEET_EXPANSIONS,
      'user.fields': USER_FIELDS,
    },
    label: 'X recent tweet search',
  });
}

export function fetchTweet(args: { id: string; bearerToken: string }): Promise<XTweetResponse> {
  return apiGet<XTweetResponse>(`${BASE_URL}/tweets/${encodeURIComponent(args.id)}`, {
    headers: authHeaders(args.bearerToken),
    query: { 'tweet.fields': TWEET_FIELDS, expansions: TWEET_EXPANSIONS, 'user.fields': USER_FIELDS },
    label: 'X tweet lookup',
  });
}

export function fetchUserByUsername(args: { username: string; bearerToken: string }): Promise<XUserResponse> {
  return apiGet<XUserResponse>(`${BASE_URL}/users/by/username/${encodeURIComponent(args.username.replace(/^@/, ''))}`, {
    headers: authHeaders(args.bearerToken),
    query: { 'user.fields': USER_FIELDS },
    label: 'X user lookup by username',
  });
}

export function fetchUserTweets(args: { id: string; bearerToken: string; max_results?: number; pagination_token?: string; start_time?: string; end_time?: string; exclude?: string }): Promise<XListResponse> {
  return apiGet<XListResponse>(`${BASE_URL}/users/${encodeURIComponent(args.id)}/tweets`, {
    headers: authHeaders(args.bearerToken),
    query: {
      max_results: args.max_results,
      pagination_token: args.pagination_token,
      start_time: args.start_time,
      end_time: args.end_time,
      exclude: args.exclude,
      'tweet.fields': TWEET_FIELDS,
      expansions: 'author_id',
      'user.fields': USER_FIELDS,
    },
    label: 'X user tweets',
  });
}

export function fetchTrendsByWoeid(args: { woeid: number; bearerToken: string; max_trends?: number }): Promise<XTrendsResponse> {
  return apiGet<XTrendsResponse>(`${BASE_URL}/trends/by/woeid/${args.woeid}`, {
    headers: authHeaders(args.bearerToken),
    query: {
      max_trends: args.max_trends,
      'trend.fields': 'trend_name,tweet_count',
    },
    label: 'X trends by location',
  });
}
