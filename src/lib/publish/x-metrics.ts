import { recentXPosts, updateXPostMetrics, type XPostLogEntry, type XPostMetrics } from "@/lib/publish/x-guard";

/**
 * Engagement read-back for the swarm's own X posts. The X rail records what
 * it posted; this reads how each post did (likes, replies, reposts, quotes,
 * impressions) with the app-only bearer, which never expires and only reads.
 * The numbers feed the producers, the critic, the coach and the X voice
 * study, so the account's voice evolves against measured response instead of
 * taste (operator directive 2026-09-12: "progressive and always evolving").
 *
 * Budget: one request per refresh (up to 25 ids), at most every 2 hours,
 * only for posts younger than 7 days. Failures are logged and retried at the
 * next window; nothing here can block posting.
 */
const REFRESH_EVERY_MS = 2 * 60 * 60_000;
const ERROR_BACKOFF_MS = 30 * 60_000;
const WINDOW_MS = 7 * 24 * 60 * 60_000;
const MAX_IDS = 25;

declare global {
  var __lauraXMetrics: { lastAt: number; lastError: string | null } | undefined;
}

function mem(): { lastAt: number; lastError: string | null } {
  if (!globalThis.__lauraXMetrics) globalThis.__lauraXMetrics = { lastAt: 0, lastError: null };
  return globalThis.__lauraXMetrics;
}

function log(msg: string): void {
  console.log(`[x-metrics ${new Date().toISOString()}] ${msg}`);
}

interface ApiTweet {
  id: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    quote_count?: number;
    impression_count?: number;
  };
}

/** Reads public_metrics for a set of tweet ids. Exported for the voice study and probes. */
export async function fetchTweetMetrics(ids: string[]): Promise<Map<string, XPostMetrics>> {
  const token = process.env.X_BEARER_TOKEN;
  if (!token) throw new Error("X_BEARER_TOKEN not set");
  const out = new Map<string, XPostMetrics>();
  if (ids.length === 0) return out;
  const url = `https://api.x.com/2/tweets?ids=${ids.slice(0, 100).join(",")}&tweet.fields=public_metrics`;
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`X API ${res.status} on /2/tweets`);
  const json = (await res.json()) as { data?: ApiTweet[] };
  const at = Date.now();
  for (const t of json.data ?? []) {
    const m = t.public_metrics ?? {};
    out.set(t.id, {
      likes: m.like_count ?? 0,
      retweets: m.retweet_count ?? 0,
      replies: m.reply_count ?? 0,
      quotes: m.quote_count ?? 0,
      impressions: m.impression_count ?? 0,
      at,
    });
  }
  return out;
}

/**
 * Scheduler hook: refreshes counters for the recent posts when the window
 * has elapsed. Cheap no-op otherwise. Never throws.
 */
export async function refreshXPostMetrics(now = Date.now()): Promise<number> {
  const m = mem();
  const wait = m.lastError ? ERROR_BACKOFF_MS : REFRESH_EVERY_MS;
  if (now - m.lastAt < wait) return 0;
  m.lastAt = now;
  try {
    const recent = (await recentXPosts(MAX_IDS)).filter((e) => now - e.at < WINDOW_MS);
    if (recent.length === 0) return 0;
    const metrics = await fetchTweetMetrics(recent.map((e) => e.firstTweetId));
    const updated = await updateXPostMetrics(metrics);
    m.lastError = null;
    log(`refreshed ${updated}/${recent.length} post(s)`);
    return updated;
  } catch (err) {
    m.lastError = String(err);
    log(`refresh failed: ${m.lastError}`);
    return 0;
  }
}

function ratePer1k(m: XPostMetrics): string {
  if (m.impressions <= 0) return "n/a";
  return `${(((m.likes + m.replies + m.retweets + m.quotes) / m.impressions) * 1000).toFixed(1)}/1k`;
}

/** One line of counters for a logged post; "" when no read exists yet. */
export function metricsLine(e: XPostLogEntry): string {
  const m = e.metrics;
  if (!m) return "";
  const ageH = Math.max(1, Math.round((m.at - e.at) / 3_600_000));
  return `${m.impressions.toLocaleString()} views, ${m.likes} likes, ${m.replies} replies, ${m.retweets + m.quotes} reposts/quotes, engagement ${ratePer1k(m)} after ${ageH}h`;
}

/**
 * Ranking of the account's own posts by total engagement (likes, replies,
 * reposts, quotes), best and worst first, so a model sees which shapes the
 * audience rewarded. Absolute counts, not rate: a post nobody saw can have a
 * flattering rate, and reach is part of what a shape earns. Empty-safe.
 */
export function xPerformanceDigest(recent: XPostLogEntry[]): string {
  const measured = recent.filter((e) => e.metrics && e.metrics.impressions > 0);
  if (measured.length === 0) return "No engagement reads yet for the account's own posts.";
  const total = (e: XPostLogEntry) => {
    const m = e.metrics!;
    return m.likes + m.replies + m.retweets + m.quotes;
  };
  const ranked = [...measured].sort((a, b) => total(b) - total(a));
  const avgViews = measured.reduce((s, e) => s + e.metrics!.impressions, 0) / measured.length;
  const avgLikes = measured.reduce((s, e) => s + e.metrics!.likes, 0) / measured.length;
  const lines = [
    `${measured.length} measured post(s): average ${Math.round(avgViews).toLocaleString()} views and ${avgLikes.toFixed(0)} likes each.`,
  ];
  const show = (label: string, e: XPostLogEntry) =>
    `${label}: "${e.text.replace(/\s+/g, " ").slice(0, 140)}" (${metricsLine(e)})`;
  lines.push(show("BEST", ranked[0]));
  if (ranked.length > 1) lines.push(show("WORST", ranked[ranked.length - 1]));
  return lines.join("\n");
}
