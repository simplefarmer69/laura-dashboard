import { promises as fs } from "node:fs";
import path from "node:path";
import { similarity } from "@/lib/swarm/novelty";

/**
 * Shared-account guardrails for the X posting rail.
 *
 * The swarm posts as @LAURA_DAIO (formerly @AiAgentkAia), the SAME account the operator's Railway NFT
 * sales bot tweets from automatically. These guards exist so the swarm
 * complements that feed instead of drowning it, and so a burst of approved
 * drafts can never turn into a burst of tweets:
 *
 *  - rate cap: a minimum interval between swarm posts plus a rolling daily
 *    ceiling (env-configurable, one publish action = one post regardless of
 *    thread length);
 *  - duplicate guard: a local memory of what the swarm already posted, so
 *    near-identical content is refused without spending API reads;
 *  - self-interaction guard: never reply to, quote or link the account's own
 *    tweets. The sales bot's posts come from the same handle, so "engaging"
 *    with them would be the account talking to itself.
 *
 * The log only tracks SWARM posts. The sales bot posts through its own
 * pipeline and is intentionally invisible here; the caps below are the swarm's
 * share of the account, not the account's total.
 */

/** The account the swarm posts as. Renamed from @AiAgentkAia to @LAURA_DAIO
    (same user id — verified via /2/users/me with the operator's OAuth 2.0
    token on 2026-09-12). */
export const X_ACCOUNT_HANDLE = "LAURA_DAIO";
export const X_ACCOUNT_PREVIOUS_HANDLE = "AiAgentkAia";
export const X_ACCOUNT_USER_ID = "1864328060327350278";

const DATA_DIR = process.env.SWARM_DATA_DIR ?? path.join(process.cwd(), "data");
const LOG_FILE = path.join(DATA_DIR, "x-post-log.json");

/** How many recent posts are kept for duplicate comparison. */
const LOG_MAX_ENTRIES = 100;
/** Posts older than this no longer count for duplicate checks. */
const DUPLICATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
/** Token-overlap score above which a candidate is a near-duplicate. */
const DUPLICATE_THRESHOLD = 0.85;

export interface XPostPolicy {
  minMinutesBetweenPosts: number;
  maxPostsPerDay: number;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolved caps. Overridable via X_MIN_MINUTES_BETWEEN_POSTS / X_MAX_POSTS_PER_DAY. */
export function xPostPolicy(): XPostPolicy {
  return {
    minMinutesBetweenPosts: envInt("X_MIN_MINUTES_BETWEEN_POSTS", 30),
    maxPostsPerDay: envInt("X_MAX_POSTS_PER_DAY", 6),
  };
}

/** Public engagement counters read back from the X API (bearer, read-only). */
export interface XPostMetrics {
  likes: number;
  retweets: number;
  replies: number;
  quotes: number;
  impressions: number;
  /** When these counters were read. */
  at: number;
}

export interface XPostLogEntry {
  at: number;
  url: string;
  firstTweetId: string;
  /** First 600 chars of the posted body, kept for duplicate comparison. */
  text: string;
  /** Latest engagement read; absent until the first refresh after posting. */
  metrics?: XPostMetrics;
}

async function readLog(): Promise<XPostLogEntry[]> {
  try {
    const raw = await fs.readFile(LOG_FILE, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as XPostLogEntry[]) : [];
  } catch {
    return [];
  }
}

/** Newest-first slice of the swarm's own X posts (originals; replies live in the mentions log). */
export async function recentXPosts(limit = 12): Promise<XPostLogEntry[]> {
  const log = await readLog();
  return log.slice(-limit).reverse();
}

/** Records a successful swarm post so future guard checks see it. */
export async function recordXPost(entry: { url: string; firstTweetId: string; text: string }): Promise<void> {
  const log = await readLog();
  log.push({ at: Date.now(), url: entry.url, firstTweetId: entry.firstTweetId, text: entry.text.slice(0, 600) });
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(LOG_FILE, JSON.stringify(log.slice(-LOG_MAX_ENTRIES), null, 2), "utf8");
}

/**
 * Writes fresh engagement counters onto logged posts (keyed by tweet id).
 * Returns how many entries changed. Entries the map does not mention keep
 * their previous read.
 */
export async function updateXPostMetrics(byId: Map<string, XPostMetrics>): Promise<number> {
  if (byId.size === 0) return 0;
  const log = await readLog();
  let updated = 0;
  for (const e of log) {
    const m = byId.get(e.firstTweetId);
    if (!m) continue;
    e.metrics = m;
    updated += 1;
  }
  if (updated > 0) await fs.writeFile(LOG_FILE, JSON.stringify(log.slice(-LOG_MAX_ENTRIES), null, 2), "utf8");
  return updated;
}

export interface XGuardVerdict {
  ok: boolean;
  /** Human-readable violations; empty when ok. */
  reasons: string[];
  policy: XPostPolicy;
  lastPostAt: number | null;
  postsLast24h: number;
  /** True when the swarm has never posted from this rail; the first live post
      should be a single controlled smoke test. */
  wouldBeFirstPost: boolean;
}

/** Links or mentions that would make the account interact with itself
    (including the sales bot's tweets, which come from the same handle). */
const SELF_INTERACTION_RE = new RegExp(
  `(?:x|twitter)\\.com/(?:${X_ACCOUNT_HANDLE}|${X_ACCOUNT_PREVIOUS_HANDLE})/status|@(?:${X_ACCOUNT_HANDLE}|${X_ACCOUNT_PREVIOUS_HANDLE})\\b`,
  "i",
);

/**
 * Checks a candidate post body against the shared-account guards. Read-only:
 * safe to call for dry runs. All violations are collected so a dry run shows
 * the full picture, not just the first problem.
 */
export async function checkXGuards(body: string): Promise<XGuardVerdict> {
  const policy = xPostPolicy();
  const log = await readLog();
  const now = Date.now();
  const reasons: string[] = [];

  const lastPostAt = log.at(-1)?.at ?? null;
  if (lastPostAt !== null) {
    const sinceMin = (now - lastPostAt) / 60_000;
    if (sinceMin < policy.minMinutesBetweenPosts) {
      reasons.push(
        `rate cap: last swarm post was ${Math.floor(sinceMin)}m ago; minimum interval is ${policy.minMinutesBetweenPosts}m`,
      );
    }
  }

  const postsLast24h = log.filter((e) => now - e.at < 24 * 60 * 60 * 1000).length;
  if (postsLast24h >= policy.maxPostsPerDay) {
    reasons.push(`daily cap: ${postsLast24h} swarm posts in the last 24h (max ${policy.maxPostsPerDay})`);
  }

  const recent = log.filter((e) => now - e.at < DUPLICATE_WINDOW_MS);
  for (const e of recent) {
    if (similarity(body, e.text) >= DUPLICATE_THRESHOLD) {
      reasons.push(`near-duplicate of an already-posted tweet (${e.url})`);
      break;
    }
  }

  if (SELF_INTERACTION_RE.test(body)) {
    reasons.push(
      `self-interaction: the body links or mentions @${X_ACCOUNT_HANDLE} itself. The NFT sales ticker posts from the same account; never reply to or quote it as if it were another party.`,
    );
  }

  return { ok: reasons.length === 0, reasons, policy, lastPostAt, postsLast24h, wouldBeFirstPost: log.length === 0 };
}
