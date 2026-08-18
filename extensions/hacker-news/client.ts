// Thin fetch helpers for the official Hacker News API (v0), one per endpoint.
// Docs: https://github.com/hackernews/api — all endpoints are unauthenticated
// GET JSON under https://hacker-news.firebaseio.com/v0. Every helper is built
// on the shared SDK's apiGet() plumbing; do not add local HTTP
// wrappers here.
import { apiGet } from '@raynard/plugin-sdk';

export const API_BASE = 'https://hacker-news.firebaseio.com/v0';

// ---------------------------------------------------------------------------
// Response types (field docs from https://github.com/hackernews/api)
// ---------------------------------------------------------------------------

/** A Hacker News item: story, comment, job, poll, or pollopt. */
export type HnItem = {
  /** The item's unique id. */
  id: number;
  /** True if the item is deleted. */
  deleted?: boolean;
  /** The type of item. One of "job", "story", "comment", "poll", or "pollopt". */
  type?: 'job' | 'story' | 'comment' | 'poll' | 'pollopt';
  /** The username of the item's author. */
  by?: string;
  /** Creation date of the item, in Unix Time (seconds). */
  time?: number;
  /** The comment, story or poll text. HTML. */
  text?: string;
  /** True if the item is dead. */
  dead?: boolean;
  /** The comment's parent: either another comment or the relevant story. */
  parent?: number;
  /** The pollopt's associated poll. */
  poll?: number;
  /** The ids of the item's comments, in ranked display order. */
  kids?: number[];
  /** The URL of the story. */
  url?: string;
  /** The story's score, or the votes for a pollopt. */
  score?: number;
  /** The title of the story, poll or job. HTML. */
  title?: string;
  /** A list of related pollopts, in display order. */
  parts?: number[];
  /** In the case of stories or polls, the total comment count. */
  descendants?: number;
};

/** A Hacker News user profile. */
export type HnUser = {
  /** The user's unique username. Case-sensitive. */
  id: string;
  /** Creation date of the user, in Unix Time (seconds). */
  created?: number;
  /** The user's karma. */
  karma?: number;
  /** The user's optional self-description. HTML. */
  about?: string;
  /** List of the user's stories, polls and comments. */
  submitted?: number[];
};

/** Live update feed: items and profiles that changed recently. */
export type HnUpdates = {
  items?: number[];
  profiles?: string[];
};

// ---------------------------------------------------------------------------
// Story-id feeds (up to 500 ids for top/new/best, 200 for ask/show/job)
// ---------------------------------------------------------------------------

/** Up to 500 of the current top story ids (front-page ranking). */
export const fetchTopStoryIds = () => apiGet<number[]>(`${API_BASE}/topstories.json`);

/** Up to 500 of the newest story ids. */
export const fetchNewStoryIds = () => apiGet<number[]>(`${API_BASE}/newstories.json`);

/** Up to 500 of the highest-voted recent story ids. */
export const fetchBestStoryIds = () => apiGet<number[]>(`${API_BASE}/beststories.json`);

/** Up to 200 of the latest Ask HN story ids. */
export const fetchAskStoryIds = () => apiGet<number[]>(`${API_BASE}/askstories.json`);

/** Up to 200 of the latest Show HN story ids. */
export const fetchShowStoryIds = () => apiGet<number[]>(`${API_BASE}/showstories.json`);

/** Up to 200 of the latest job posting ids. */
export const fetchJobStoryIds = () => apiGet<number[]>(`${API_BASE}/jobstories.json`);

// ---------------------------------------------------------------------------
// Items, users, and metadata
// ---------------------------------------------------------------------------

/**
 * Fetch one item (story, comment, job, poll, or pollopt) by its numeric id.
 * The API returns JSON null for deleted/missing items, so this can be null.
 */
export const fetchItem = (id: number) => apiGet<HnItem | null>(`${API_BASE}/item/${id}.json`);

/**
 * Fetch several items in parallel, preserving id order and dropping entries
 * the API reports as null or deleted.
 */
export async function fetchItems(ids: number[]): Promise<HnItem[]> {
  const items = await Promise.all(ids.map((id) => fetchItem(id)));
  return items.filter((item): item is HnItem => Boolean(item) && !item!.deleted);
}

/**
 * Fetch a user profile by case-sensitive username.
 * The API returns JSON null for unknown usernames, so this can be null.
 */
export const fetchUser = (username: string) =>
  apiGet<HnUser | null>(`${API_BASE}/user/${encodeURIComponent(username)}.json`);

/** The current largest item id — a cheap activity/heartbeat metric. */
export const fetchMaxItemId = () => apiGet<number>(`${API_BASE}/maxitem.json`);

/** Item ids and profile names that changed recently (the "live updates" feed). */
export const fetchUpdates = () => apiGet<HnUpdates>(`${API_BASE}/updates.json`);
