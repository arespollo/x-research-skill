/**
 * X API wrapper — via RapidAPI (twitter-api45).
 * Uses env: RAPIDAPI_KEY
 */

import { readFileSync } from "fs";

const RAPIDAPI_HOST = "twitter-api45.p.rapidapi.com";
const BASE = `https://${RAPIDAPI_HOST}`;
const RATE_DELAY_MS = 500;

function getKey(): string {
  if (process.env.RAPIDAPI_KEY) return process.env.RAPIDAPI_KEY;

  // Try global.env
  try {
    const envFile = readFileSync(
      `${process.env.HOME}/.config/env/global.env`,
      "utf-8"
    );
    const match = envFile.match(/RAPIDAPI_KEY=["']?([^"'\n]+)/);
    if (match) return match[1];
  } catch {}

  throw new Error(
    "RAPIDAPI_KEY not found in env or ~/.config/env/global.env"
  );
}

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

export interface Tweet {
  id: string;
  text: string;
  author_id: string;
  username: string;
  name: string;
  created_at: string;
  conversation_id: string;
  metrics: {
    likes: number;
    retweets: number;
    replies: number;
    quotes: number;
    impressions: number;
    bookmarks: number;
  };
  urls: string[];
  mentions: string[];
  hashtags: string[];
  tweet_url: string;
}

async function rapidGet(url: string): Promise<any> {
  const key = getKey();
  const res = await fetch(url, {
    headers: {
      "x-rapidapi-host": RAPIDAPI_HOST,
      "x-rapidapi-key": key,
    },
  });

  if (res.status === 429) {
    throw new Error("RapidAPI rate limited. Try again later.");
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`RapidAPI ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Convert a RapidAPI timeline tweet object to our Tweet interface.
 */
function parseTimelineTweet(t: any): Tweet {
  const username = t.screen_name || t.author?.screen_name || "?";
  const name = t.user_info?.name || t.author?.name || username;
  const views = parseInt(t.views || "0") || 0;

  return {
    id: t.tweet_id || t.id || "",
    text: t.text || "",
    author_id: t.user_info?.rest_id || t.author?.rest_id || "",
    username,
    name,
    created_at: t.created_at || "",
    conversation_id: t.conversation_id || t.tweet_id || t.id || "",
    metrics: {
      likes: t.favorites || t.likes || 0,
      retweets: t.retweets || 0,
      replies: t.replies || 0,
      quotes: t.quotes || 0,
      impressions: views,
      bookmarks: t.bookmarks || 0,
    },
    urls: extractUrls(t),
    mentions: extractMentions(t),
    hashtags: extractHashtags(t),
    tweet_url: `https://x.com/${username}/status/${t.tweet_id || t.id || ""}`,
  };
}

function extractUrls(t: any): string[] {
  const urls: string[] = [];
  for (const u of t.entities?.urls || []) {
    if (u.expanded_url) urls.push(u.expanded_url);
  }
  return urls;
}

function extractMentions(t: any): string[] {
  const mentions: string[] = [];
  for (const m of t.entities?.user_mentions || []) {
    if (m.screen_name) mentions.push(m.screen_name);
  }
  return mentions;
}

function extractHashtags(t: any): string[] {
  const tags: string[] = [];
  for (const h of t.entities?.hashtags || []) {
    if (h.text || h.tag) tags.push(h.text || h.tag);
  }
  return tags;
}

/**
 * Search tweets via RapidAPI.
 * search_type: Top, Latest, Photos, Videos
 */
export async function search(
  query: string,
  opts: {
    maxResults?: number;
    pages?: number;
    sortOrder?: "relevancy" | "recency";
    since?: string;
  } = {}
): Promise<Tweet[]> {
  const pages = opts.pages || 1;
  const searchType = opts.sortOrder === "recency" ? "Latest" : "Top";
  const encoded = encodeURIComponent(query);

  let allTweets: Tweet[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < pages; page++) {
    const cursorParam = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
    const url = `${BASE}/search.php?query=${encoded}&search_type=${searchType}${cursorParam}`;

    const raw = await rapidGet(url);

    if (raw.timeline && Array.isArray(raw.timeline)) {
      for (const item of raw.timeline) {
        if (item.type === "tweet") {
          allTweets.push(parseTimelineTweet(item));
        }
      }
    }

    cursor = raw.next_cursor;
    if (!cursor) break;
    if (page < pages - 1) await sleep(RATE_DELAY_MS);
  }

  // Apply since filter client-side if provided
  if (opts.since) {
    const sinceMs = parseSinceMs(opts.since);
    if (sinceMs) {
      const cutoff = Date.now() - sinceMs;
      allTweets = allTweets.filter(
        (t) => new Date(t.created_at).getTime() >= cutoff
      );
    }
  }

  return allTweets;
}

/**
 * Parse since value to milliseconds.
 */
function parseSinceMs(since: string): number | null {
  const match = since.match(/^(\d+)(m|h|d)$/);
  if (match) {
    const num = parseInt(match[1]);
    const unit = match[2];
    return unit === "m" ? num * 60_000 : unit === "h" ? num * 3_600_000 : num * 86_400_000;
  }
  return null;
}

/**
 * Fetch a single tweet by ID.
 */
export async function getTweet(tweetId: string): Promise<Tweet | null> {
  const url = `${BASE}/tweet.php?id=${tweetId}`;
  const raw = await rapidGet(url);

  if (!raw || raw.status === "error") return null;

  return parseTimelineTweet(raw);
}

/**
 * Fetch a full conversation thread by root tweet ID.
 */
export async function thread(
  conversationId: string,
  opts: { pages?: number } = {}
): Promise<Tweet[]> {
  // Get the root tweet first
  const tweets: Tweet[] = [];
  const root = await getTweet(conversationId);
  if (root) tweets.push(root);

  // Search for conversation replies
  await sleep(RATE_DELAY_MS);
  const query = `conversation_id:${conversationId}`;
  const replies = await search(query, {
    pages: opts.pages || 2,
    sortOrder: "recency",
  });
  tweets.push(...replies);

  return dedupe(tweets);
}

/**
 * Get user profile info + recent tweets.
 */
export async function profile(
  username: string,
  opts: { count?: number; includeReplies?: boolean } = {}
): Promise<{ user: any; tweets: Tweet[] }> {
  // Fetch user info
  const userUrl = `${BASE}/screenname.php?screenname=${encodeURIComponent(username)}`;
  const userData = await rapidGet(userUrl);

  if (!userData || userData.status === "error") {
    throw new Error(`User @${username} not found`);
  }

  // Normalize user object to match expected format
  const user = {
    username: userData.profile || username,
    name: userData.name || username,
    description: userData.desc || "",
    created_at: userData.created_at || "",
    public_metrics: {
      followers_count: userData.sub_count || 0,
      following_count: userData.friends || 0,
      tweet_count: userData.statuses_count || 0,
    },
  };

  await sleep(RATE_DELAY_MS);

  // Fetch recent tweets via search
  const replyFilter = opts.includeReplies ? "" : " -is:reply";
  const query = `from:${username} -is:retweet${replyFilter}`;
  const tweets = await search(query, {
    maxResults: opts.count || 20,
    sortOrder: "recency",
  });

  return { user, tweets };
}

/**
 * Sort tweets by engagement metric.
 */
export function sortBy(
  tweets: Tweet[],
  metric: "likes" | "impressions" | "retweets" | "replies" = "likes"
): Tweet[] {
  return [...tweets].sort((a, b) => b.metrics[metric] - a.metrics[metric]);
}

/**
 * Filter tweets by minimum engagement.
 */
export function filterEngagement(
  tweets: Tweet[],
  opts: { minLikes?: number; minImpressions?: number }
): Tweet[] {
  return tweets.filter((t) => {
    if (opts.minLikes && t.metrics.likes < opts.minLikes) return false;
    if (opts.minImpressions && t.metrics.impressions < opts.minImpressions)
      return false;
    return true;
  });
}

/**
 * Deduplicate tweets by ID.
 */
export function dedupe(tweets: Tweet[]): Tweet[] {
  const seen = new Set<string>();
  return tweets.filter((t) => {
    if (seen.has(t.id)) return false;
    seen.add(t.id);
    return true;
  });
}
