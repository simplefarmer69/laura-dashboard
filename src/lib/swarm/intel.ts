import type { IntelSnapshot, IntelTweet, Settings, XIntel } from "@/lib/types";

/**
 * LAURA's live-internet intelligence layer: real reads from the open internet
 * every cycle, so agents reason from TODAY's world instead of only protocol
 * metrics.
 *
 * Verified working with current credentials (2026-09-10):
 *  - X API v2 app-only bearer (X_BEARER_TOKEN, READ ONLY): recent tweet
 *    search, user lookup, user timelines. Posting needs the access-token
 *    pair the operator has not shipped yet.
 *  - CoinGecko simple price (keyless).
 *  - Blockscout (robinhoodchain.blockscout.com) sits behind a Cloudflare JS
 *    challenge from this host — the fetcher stays wired and degrades to null
 *    so holder counts light up automatically wherever the challenge clears.
 *
 * Every fetcher is non-fatal with a short timeout and its own cache so a
 * burst of cycles (manual + event) never hammers an upstream. 429s skip the
 * cycle and say so in warnings instead of failing it.
 */

const TIMEOUT_MS = 12_000;

/** Robinhood leadership accounts; ids resolved once via /2/users/by (2026-09-10). */
export const X_LEADERS = [
  { username: "vladtenev", id: "605700792" },
  { username: "JohannKerbrat", id: "1419089826586918913" },
] as const;

const X_SEARCH_QUERY = "$STONKBROKER OR StonkBrokers OR stonkbrokers.cash";

interface Cache<T> {
  at: number;
  value: T;
}

/* Survive Next.js dev HMR re-imports, like the archive connection does. */
declare global {
  var __lauraIntelCache:
    | {
        search?: Cache<{ count: number; engagement: number; top: IntelTweet[] }>;
        leaders?: Cache<XIntel["leaders"]>;
        eth?: Cache<{ usd: number; change24hPct: number }>;
        blockscout?: Cache<{ holders: number | null; transfers: number | null }>;
      }
    | undefined;
}

function caches() {
  if (!globalThis.__lauraIntelCache) globalThis.__lauraIntelCache = {};
  return globalThis.__lauraIntelCache;
}

const SEARCH_TTL_MS = 20 * 60_000;
const LEADERS_TTL_MS = 60 * 60_000;
const ETH_TTL_MS = 10 * 60_000;
const BLOCKSCOUT_TTL_MS = 30 * 60_000;

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "stonk-swarm/0.1", ...headers },
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

function bearer(): string | null {
  return process.env.X_BEARER_TOKEN || null;
}

interface XApiTweet {
  id: string;
  author_id?: string;
  created_at?: string;
  text: string;
  public_metrics?: {
    like_count?: number;
    retweet_count?: number;
    reply_count?: number;
    impression_count?: number;
  };
}

function toIntelTweet(t: XApiTweet, author?: string): IntelTweet {
  const m = t.public_metrics ?? {};
  return {
    id: t.id,
    author: author ?? t.author_id ?? "?",
    createdAt: t.created_at ?? "",
    text: t.text.replace(/\s+/g, " ").slice(0, 240),
    likes: m.like_count ?? 0,
    retweets: m.retweet_count ?? 0,
    replies: m.reply_count ?? 0,
    impressions: m.impression_count ?? 0,
  };
}

function engagementOf(t: IntelTweet): number {
  return t.likes + t.retweets + t.replies;
}

/** Recent-search mentions of $STONKBROKER in the last 24h (app-only bearer). */
async function fetchXMentions(): Promise<{ count: number; engagement: number; top: IntelTweet[] }> {
  const c = caches();
  if (c.search && Date.now() - c.search.at < SEARCH_TTL_MS) return c.search.value;
  const token = bearer();
  if (!token) throw new Error("X_BEARER_TOKEN not set");
  const startTime = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const url =
    `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(X_SEARCH_QUERY)}` +
    `&max_results=50&start_time=${encodeURIComponent(startTime)}` +
    `&tweet.fields=public_metrics,created_at,author_id`;
  const json = await getJson<{ data?: XApiTweet[]; meta?: { result_count?: number } }>(url, {
    authorization: `Bearer ${token}`,
  });
  const tweets = (json.data ?? []).map((t) => toIntelTweet(t));
  const value = {
    count: json.meta?.result_count ?? tweets.length,
    engagement: tweets.reduce((s, t) => s + engagementOf(t), 0),
    top: [...tweets].sort((a, b) => engagementOf(b) - engagementOf(a)).slice(0, 3),
  };
  c.search = { at: Date.now(), value };
  return value;
}

/** Latest original tweets from Robinhood leadership (no replies/retweets). */
async function fetchXLeaders(): Promise<XIntel["leaders"]> {
  const c = caches();
  if (c.leaders && Date.now() - c.leaders.at < LEADERS_TTL_MS) return c.leaders.value;
  const token = bearer();
  if (!token) throw new Error("X_BEARER_TOKEN not set");
  const leaders: XIntel["leaders"] = [];
  for (const leader of X_LEADERS) {
    const url =
      `https://api.x.com/2/users/${leader.id}/tweets?max_results=5&exclude=replies,retweets` +
      `&tweet.fields=created_at,public_metrics`;
    const json = await getJson<{ data?: XApiTweet[] }>(url, { authorization: `Bearer ${token}` });
    leaders.push({
      username: leader.username,
      tweets: (json.data ?? []).slice(0, 3).map((t) => toIntelTweet(t, leader.username)),
    });
  }
  c.leaders = { at: Date.now(), value: leaders };
  return leaders;
}

/** ETH macro context from CoinGecko (keyless simple price). */
async function fetchEth(): Promise<{ usd: number; change24hPct: number }> {
  const c = caches();
  if (c.eth && Date.now() - c.eth.at < ETH_TTL_MS) return c.eth.value;
  const json = await getJson<{ ethereum?: { usd?: number; usd_24h_change?: number } }>(
    "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd&include_24hr_change=true",
  );
  if (!json.ethereum?.usd) throw new Error("CoinGecko returned no ETH price");
  const value = { usd: json.ethereum.usd, change24hPct: json.ethereum.usd_24h_change ?? 0 };
  c.eth = { at: Date.now(), value };
  return value;
}

/** $STONKBROKER holder/transfer counters from the Robinhood Chain Blockscout. */
async function fetchBlockscout(settings: Settings): Promise<{ holders: number | null; transfers: number | null }> {
  const c = caches();
  if (c.blockscout && Date.now() - c.blockscout.at < BLOCKSCOUT_TTL_MS) return c.blockscout.value;
  const json = await getJson<{ token_holders_count?: string; transfers_count?: string }>(
    `https://robinhoodchain.blockscout.com/api/v2/tokens/${settings.tokenAddress}/counters`,
  );
  const value = {
    holders: json.token_holders_count ? Number(json.token_holders_count) : null,
    transfers: json.transfers_count ? Number(json.transfers_count) : null,
  };
  c.blockscout = { at: Date.now(), value };
  return value;
}

/**
 * Gathers the cycle's live-internet snapshot. Never throws: every source is
 * settled independently; failures become warnings and null fields, with the
 * previous snapshot's Blockscout numbers carried forward so a transient
 * outage doesn't zero a trend.
 */
export async function collectIntel(
  settings: Settings,
  prev: IntelSnapshot | null,
): Promise<IntelSnapshot> {
  const [search, leaders, eth, chain] = await Promise.allSettled([
    fetchXMentions(),
    fetchXLeaders(),
    fetchEth(),
    fetchBlockscout(settings),
  ]);
  const sources: string[] = [];
  const warnings: string[] = [];
  const xNotes: string[] = [];

  let x: XIntel | null = null;
  const searchOk = search.status === "fulfilled";
  const leadersOk = leaders.status === "fulfilled";
  if (searchOk) {
    sources.push("x-search");
    xNotes.push("search ok");
  } else {
    const msg = String(search.reason);
    warnings.push(`X search: ${msg}${msg.includes("429") ? " (rate-limited; skipped this cycle)" : ""}`);
    xNotes.push("search unavailable");
  }
  if (leadersOk) {
    sources.push("x-timelines");
    xNotes.push("leader timelines ok");
  } else {
    const msg = String(leaders.reason);
    warnings.push(`X timelines: ${msg}${msg.includes("429") ? " (rate-limited; skipped this cycle)" : ""}`);
    xNotes.push("leader timelines unavailable");
  }
  if (searchOk || leadersOk) {
    x = {
      fetchedAt: Date.now(),
      mentionCount24h: searchOk ? search.value.count : (prev?.x?.mentionCount24h ?? 0),
      engagement24h: searchOk ? search.value.engagement : (prev?.x?.engagement24h ?? 0),
      topMentions: searchOk ? search.value.top : (prev?.x?.topMentions ?? []),
      leaders: leadersOk ? leaders.value : (prev?.x?.leaders ?? []),
      note: xNotes.join("; "),
    };
  }

  let ethUsd: number | null = null;
  let ethChange: number | null = null;
  if (eth.status === "fulfilled") {
    sources.push("coingecko");
    ethUsd = eth.value.usd;
    ethChange = eth.value.change24hPct;
  } else {
    warnings.push(`CoinGecko: ${String(eth.reason)}`);
  }

  let holders: number | null = prev?.holderCount ?? null;
  let transfers: number | null = prev?.tokenTransferCount ?? null;
  if (chain.status === "fulfilled") {
    sources.push("blockscout");
    holders = chain.value.holders ?? holders;
    transfers = chain.value.transfers ?? transfers;
  } else {
    warnings.push(`Blockscout: ${String(chain.reason)} (holder count carried forward)`);
  }

  return {
    ts: Date.now(),
    x,
    ethUsd,
    ethUsd24hChangePct: ethChange,
    holderCount: holders,
    tokenTransferCount: transfers,
    sources,
    warnings,
  };
}

function ago(ts: string): string {
  const ms = Date.now() - new Date(ts).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.max(1, Math.round(ms / 60_000))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
}

/**
 * Compact (~1500 chars) prompt injection: what the live internet says TODAY.
 * History gives the mention/engagement trend so influence reads as a delta,
 * not a lone number.
 */
export function intelDigest(current: IntelSnapshot | null, history: IntelSnapshot[]): string {
  if (!current) return "Live internet intel unavailable this cycle (all fetchers failed).";
  const lines: string[] = [];
  const dayAgo = current.ts - 24 * 3600 * 1000;
  const prior = [...history].reverse().find((s) => s.ts <= dayAgo && s.x);

  if (current.x) {
    const trend =
      prior?.x && prior.x.mentionCount24h > 0
        ? ` (yesterday: ${prior.x.mentionCount24h} mentions, ${prior.x.engagement24h} engagements)`
        : "";
    lines.push(
      `X mentions of $STONKBROKER/StonkBrokers last 24h: ${current.x.mentionCount24h} tweets, ${current.x.engagement24h} total engagements (likes+RTs+replies)${trend}. [${current.x.note}]`,
    );
    for (const t of current.x.topMentions.slice(0, 2)) {
      lines.push(`- Top mention (${engagementOf(t)} eng, ${ago(t.createdAt)}): "${t.text.slice(0, 160)}"`);
    }
    for (const leader of current.x.leaders) {
      const t = leader.tweets[0];
      if (!t) continue;
      lines.push(
        `- @${leader.username} latest (${ago(t.createdAt)}, ${t.likes} likes, ${t.impressions.toLocaleString()} impressions): "${t.text.slice(0, 180)}"`,
      );
    }
  } else {
    lines.push("X reads unavailable this cycle (rate-limited or blocked) — do not invent tweet content.");
  }

  if (current.ethUsd !== null) {
    lines.push(
      `ETH $${current.ethUsd.toFixed(0)} (${(current.ethUsd24hChangePct ?? 0) >= 0 ? "+" : ""}${(current.ethUsd24hChangePct ?? 0).toFixed(1)}% 24h) — macro context for launch/liquidity framing.`,
    );
  }
  if (current.holderCount !== null) {
    const priorHolders = prior?.holderCount ?? null;
    const delta = priorHolders !== null ? ` (${current.holderCount - priorHolders >= 0 ? "+" : ""}${current.holderCount - priorHolders} vs ~24h ago)` : "";
    lines.push(`$STONKBROKER holders (Blockscout): ${current.holderCount.toLocaleString()}${delta}; lifetime transfers ${current.tokenTransferCount?.toLocaleString() ?? "n/a"}.`);
  } else {
    lines.push("Holder count: Blockscout unreachable from this host (Cloudflare challenge); trend unavailable.");
  }
  if (current.warnings.length > 0) lines.push(`Intel warnings: ${current.warnings.join(" · ")}`);
  return lines.join("\n").slice(0, 1500);
}
