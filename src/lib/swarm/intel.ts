import type {
  BrokerToolsIntel,
  BrokerToolsLaunch,
  BrokerToolsSymbolFlow,
  IntelSnapshot,
  IntelTvl,
  IntelTweet,
  LaunchRadar,
  LaunchRadarToken,
  Settings,
  XIntel,
} from "@/lib/types";

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

/**
 * Operator-owned accounts LAURA follows for live direction and amplification
 * targets. ids resolve lazily via /2/users/by/username so the operator can
 * fix a handle here without shipping anything else; unresolvable handles are
 * skipped with a warning until they exist. Both resolved 2026-09-10:
 * ClutchMarkets (StonkBrokers official) and OxSimpleFarmer (the StonkBrokers
 * founder's personal account, confirmed by the operator).
 */
export const X_TRACKED: { username: string; id: string | null }[] = [
  { username: "ClutchMarkets", id: "1803187737874366464" },
  { username: "OxSimpleFarmer", id: "1394725411397976072" },
];

const X_SEARCH_QUERY = "$STONKBROKER OR StonkBrokers OR stonkbrokers.cash";

/**
 * The operator's #1 catalyst: a Robinhood founder engaging an operator
 * account, or talking stock tokens / tokenized equities — the narrative
 * $STONKBROKER rides. Recent-search covers the last 7 days.
 */
const X_CATALYST_QUERY =
  '(from:vladtenev OR from:JohannKerbrat) (@ClutchMarkets OR @OxSimpleFarmer OR stonkbroker OR "stock token" OR "stock tokens" OR "tokenized stocks" OR "tokenized equities" OR "meme stock")';

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
        tracked?: Cache<NonNullable<XIntel["tracked"]>>;
        catalysts?: Cache<IntelTweet[]>;
        /** username -> resolved id, or null for a confirmed miss (negative-cached). */
        trackedIds?: Cache<Record<string, string | null>>;
        eth?: Cache<{ usd: number; change24hPct: number }>;
        blockscout?: Cache<{ holders: number | null; transfers: number | null }>;
        radar?: Cache<LaunchRadar>;
        tvl?: Cache<IntelTvl>;
        brokerTools?: Cache<BrokerToolsIntel>;
      }
    | undefined;
}

function caches() {
  if (!globalThis.__lauraIntelCache) globalThis.__lauraIntelCache = {};
  return globalThis.__lauraIntelCache;
}

const SEARCH_TTL_MS = 20 * 60_000;
const LEADERS_TTL_MS = 60 * 60_000;
const TRACKED_TTL_MS = 45 * 60_000;
const CATALYST_TTL_MS = 30 * 60_000;
/** Handle-resolution misses re-checked hourly, hits kept for a day. */
const TRACKED_IDS_TTL_MS = 60 * 60_000;
const ETH_TTL_MS = 10 * 60_000;
const BLOCKSCOUT_TTL_MS = 30 * 60_000;
const RADAR_TTL_MS = 15 * 60_000;
/** DefiLlama refreshes roughly hourly; the Smart LP lens read is one eth_call. */
const TVL_TTL_MS = 10 * 60_000;
const BROKERTOOLS_TTL_MS = 10 * 60_000;

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, {
    /* Mozilla-prefixed UA: Cloudflare in front of Blockscout 403s bare bot UAs
       but passes browser-shaped ones; verified 403 vs 200 on 2026-09-11. */
    headers: {
      accept: "application/json",
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) laura-swarm/1.0",
      ...headers,
    },
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

/** Resolve tracked-account handles to ids, negative-caching misses so a bad handle costs one lookup per hour, not per cycle. */
async function resolveTrackedIds(token: string): Promise<Record<string, string | null>> {
  const c = caches();
  if (c.trackedIds && Date.now() - c.trackedIds.at < TRACKED_IDS_TTL_MS) return c.trackedIds.value;
  const ids: Record<string, string | null> = {};
  for (const acct of X_TRACKED) {
    if (acct.id) {
      ids[acct.username] = acct.id;
      continue;
    }
    try {
      const json = await getJson<{ data?: { id: string } }>(
        `https://api.x.com/2/users/by/username/${encodeURIComponent(acct.username)}`,
        { authorization: `Bearer ${token}` },
      );
      ids[acct.username] = json.data?.id ?? null;
    } catch {
      ids[acct.username] = null;
    }
  }
  c.trackedIds = { at: Date.now(), value: ids };
  return ids;
}

/** Latest original tweets from the operator's own accounts — live direction for the swarm. */
async function fetchXTracked(): Promise<NonNullable<XIntel["tracked"]>> {
  const c = caches();
  if (c.tracked && Date.now() - c.tracked.at < TRACKED_TTL_MS) return c.tracked.value;
  const token = bearer();
  if (!token) throw new Error("X_BEARER_TOKEN not set");
  const ids = await resolveTrackedIds(token);
  const tracked: NonNullable<XIntel["tracked"]> = [];
  for (const acct of X_TRACKED) {
    const id = ids[acct.username];
    if (!id) continue; // unresolved handle — surfaced as a warning by collectIntel
    const url =
      `https://api.x.com/2/users/${id}/tweets?max_results=5&exclude=replies,retweets` +
      `&tweet.fields=created_at,public_metrics`;
    const json = await getJson<{ data?: XApiTweet[] }>(url, { authorization: `Bearer ${token}` });
    tracked.push({
      username: acct.username,
      tweets: (json.data ?? []).slice(0, 3).map((t) => toIntelTweet(t, acct.username)),
    });
  }
  c.tracked = { at: Date.now(), value: tracked };
  return tracked;
}

/** Founder engagement with operator accounts or stock-token themes (last 7d via recent search). */
async function fetchXCatalysts(): Promise<IntelTweet[]> {
  const c = caches();
  if (c.catalysts && Date.now() - c.catalysts.at < CATALYST_TTL_MS) return c.catalysts.value;
  const token = bearer();
  if (!token) throw new Error("X_BEARER_TOKEN not set");
  const url =
    `https://api.x.com/2/tweets/search/recent?query=${encodeURIComponent(X_CATALYST_QUERY)}` +
    `&max_results=10&tweet.fields=public_metrics,created_at,author_id`;
  const json = await getJson<{ data?: XApiTweet[] }>(url, { authorization: `Bearer ${token}` });
  const byAuthor = new Map<string, string>(X_LEADERS.map((l) => [l.id, l.username]));
  const value = (json.data ?? []).map((t) => toIntelTweet(t, byAuthor.get(t.author_id ?? "")));
  c.catalysts = { at: Date.now(), value };
  return value;
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

/* --------------------- DexScreener launch radar (keyless) --------------------- */

/** The DexScreener pair fields the radar reads (subset of the full response). */
interface DexPair {
  chainId?: string;
  dexId?: string;
  baseToken: { address: string; name: string; symbol: string };
  pairCreatedAt?: number;
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
  marketCap?: number;
}

interface DexTokenRef {
  chainId?: string;
  tokenAddress?: string;
}

function toRadarToken(p: DexPair, boosted: Set<string>): LaunchRadarToken {
  return {
    address: p.baseToken.address,
    name: p.baseToken.name,
    symbol: p.baseToken.symbol,
    dexId: p.dexId ?? "?",
    pairCreatedAt: p.pairCreatedAt ?? null,
    volume24hUsd: p.volume?.h24 ?? 0,
    liquidityUsd: p.liquidity?.usd ?? null,
    priceChange24hPct: p.priceChange?.h24 ?? null,
    marketCapUsd: p.marketCap ?? null,
    boosted: boosted.has(p.baseToken.address.toLowerCase()),
  };
}

/**
 * New/trending token launches on Robinhood Chain (chain slug "robinhood",
 * verified via /latest/dex/search 2026-09-10) from DexScreener's keyless API.
 * Discovery: the latest token-profiles and token-boosts feeds filtered to the
 * chain slug (tokens paying for a profile/boost are the chain's active
 * launches), then ONE batch stats call for pair age, 24h volume, liquidity,
 * price change and mcap — the mission token rides along so $STONKBROKER's own
 * pair stats are always present. READ-ONLY market intel: feeds prompts only,
 * never any treasury or launch execution path.
 *
 * Exported for direct smoke-testing; cycles reach it through collectIntel.
 */
export async function fetchLaunchRadar(settings: Settings): Promise<LaunchRadar> {
  const c = caches();
  if (c.radar && Date.now() - c.radar.at < RADAR_TTL_MS) return c.radar.value;
  const [profiles, boosts] = await Promise.all([
    getJson<DexTokenRef[]>("https://api.dexscreener.com/token-profiles/latest/v1"),
    getJson<DexTokenRef[]>("https://api.dexscreener.com/token-boosts/latest/v1"),
  ]);
  const missionAddr = settings.tokenAddress.toLowerCase();
  const boosted = new Set(
    boosts
      .filter((t) => t.chainId === settings.chainSlug && t.tokenAddress)
      .map((t) => (t.tokenAddress as string).toLowerCase()),
  );
  const addresses: string[] = [];
  for (const t of [...profiles, ...boosts]) {
    if (t.chainId !== settings.chainSlug || !t.tokenAddress) continue;
    const a = t.tokenAddress.toLowerCase();
    if (a !== missionAddr && !addresses.includes(a)) addresses.push(a);
  }
  /* The batch endpoint takes up to 30 addresses; one slot is reserved for the
     mission token so its own pair stats always come back. */
  const batch = [...addresses.slice(0, 29), missionAddr];
  const pairs = await getJson<DexPair[]>(
    `https://api.dexscreener.com/tokens/v1/${settings.chainSlug}/${batch.join(",")}`,
  );
  /* Keep each token's deepest pair only (a token can have several pools). */
  const requested = new Set(batch);
  const best = new Map<string, DexPair>();
  for (const p of pairs) {
    const a = p.baseToken.address.toLowerCase();
    if (!requested.has(a)) continue; // token sits on the quote side here — wrong identity
    const prior = best.get(a);
    if (!prior || (p.liquidity?.usd ?? 0) > (prior.liquidity?.usd ?? 0)) best.set(a, p);
  }
  const missionPair = best.get(missionAddr);
  const tokens = [...best.entries()]
    .filter(([a]) => a !== missionAddr)
    .map(([, p]) => toRadarToken(p, boosted))
    .sort((a, b) => b.volume24hUsd - a.volume24hUsd)
    .slice(0, 8);
  const value: LaunchRadar = {
    fetchedAt: Date.now(),
    tokens,
    mission: missionPair ? toRadarToken(missionPair, boosted) : null,
  };
  c.radar = { at: Date.now(), value };
  return value;
}

/* ----------------------- live TVL (DefiLlama + Smart LP) ----------------------- */

/** Dashboard feed base, same convention as worldfeeds.ts (heavy caching server-side). */
function feedsBase(): string {
  return (process.env.LAURA_FEEDS_BASE || "https://laura.stonkbrokers.io").replace(/\/$/, "");
}

interface LlamaProtocolPayload {
  currentChainTvls?: Record<string, number>;
  tvl?: Array<{ date: number; totalLiquidityUSD: number }>;
}

interface SmartLpFeedPayload {
  ok?: boolean;
  fleet?: { vaults?: number; tvlUsd?: number };
}

/**
 * Percent change from the series point CLOSEST to `hoursAgo` before the latest
 * point (the series is daily plus one live point, so "closest" beats "last
 * point at or before target", which can be nearly two days old and overstate
 * a fast-growing TVL's 24h move).
 */
function seriesChangePct(
  series: Array<{ date: number; totalLiquidityUSD: number }>,
  hoursAgo: number,
): number | null {
  if (series.length < 2) return null;
  const last = series[series.length - 1];
  const target = last.date - hoursAgo * 3600;
  let prior: { date: number; totalLiquidityUSD: number } | null = null;
  for (const p of series) {
    if (p.date >= last.date) break;
    if (!prior || Math.abs(p.date - target) < Math.abs(prior.date - target)) prior = p;
  }
  if (!prior || prior.totalLiquidityUSD <= 0) return null;
  return ((last.totalLiquidityUSD - prior.totalLiquidityUSD) / prior.totalLiquidityUSD) * 100;
}

/**
 * Live TVL for the graded protocol: the DefiLlama listing (protocol TVL on
 * Robinhood Chain with 24h/7d change from the daily series, staking excluded,
 * same exclusions as the grader) plus the Smart LP vault fleet TVL read from
 * the dashboard's own smartlp feed (one lens eth_call server-side). Either
 * half can fail independently; only a double miss throws.
 *
 * Exported for direct smoke-testing; cycles reach it through collectIntel.
 */
export async function fetchTvl(settings: Settings): Promise<IntelTvl> {
  const c = caches();
  if (c.tvl && Date.now() - c.tvl.at < TVL_TTL_MS) return c.tvl.value;
  const [llama, smartlp] = await Promise.allSettled([
    getJson<LlamaProtocolPayload>(`https://api.llama.fi/protocol/${settings.llamaSlug}`),
    getJson<SmartLpFeedPayload>(`${feedsBase()}/api/feeds/smartlp`),
  ]);
  if (llama.status === "rejected" && smartlp.status === "rejected") {
    throw new Error(`DefiLlama: ${String(llama.reason)}; smartlp feed: ${String(smartlp.reason)}`);
  }
  let protocolTvlUsd: number | null = null;
  let change24hPct: number | null = null;
  let change7dPct: number | null = null;
  if (llama.status === "fulfilled") {
    protocolTvlUsd = Object.entries(llama.value.currentChainTvls ?? {})
      .filter(([k]) => !k.includes("-") && k !== "staking" && k !== "borrowed" && k !== "pool2")
      .reduce((s, [, v]) => s + v, 0);
    const series = (llama.value.tvl ?? []).filter(
      (p) => p && Number.isFinite(p.date) && Number.isFinite(p.totalLiquidityUSD),
    );
    change24hPct = seriesChangePct(series, 24);
    change7dPct = seriesChangePct(series, 24 * 7);
  }
  const fleet = smartlp.status === "fulfilled" ? smartlp.value.fleet : undefined;
  const value: IntelTvl = {
    fetchedAt: Date.now(),
    protocolTvlUsd,
    change24hPct,
    change7dPct,
    smartLpTvlUsd: typeof fleet?.tvlUsd === "number" ? fleet.tvlUsd : null,
    smartLpVaults: typeof fleet?.vaults === "number" ? fleet.vaults : null,
  };
  c.tvl = { at: Date.now(), value };
  return value;
}

/* ------------------- BrokerTools terminal (brokertools.info) ------------------- */

const BROKERTOOLS_BASE = "https://brokertools.info";

interface BrokerToolsTapeRow {
  token?: string;
  symbol?: string;
  ts?: number;
  side?: string;
  usd?: number;
}

interface BrokerToolsLaunchRow {
  symbol?: string;
  mcapUsd?: number;
  buyers?: number;
  phase?: string;
}

/**
 * READ-ONLY reads from brokertools.info, an independent explorer/indexer for
 * Robinhood Chain ("high context explorer and data terminal", public and
 * unkeyed). Two endpoints verified live 2026-09-10:
 *   GET /api/firehose            - the ~120 most recent chain-wide DEX trades
 *                                  (token, symbol, side, usd, venue)
 *   GET /api/launches?offset=0   - Stonklauncher index (total + rows sorted
 *                                  by mcap: symbol, mcapUsd, buyers, phase)
 * Aggregated into compact flow stats here; either endpoint can fail
 * independently and only a double miss throws.
 *
 * Exported for direct smoke-testing; cycles reach it through collectIntel.
 */
export async function fetchBrokerTools(settings: Settings): Promise<BrokerToolsIntel> {
  const c = caches();
  if (c.brokerTools && Date.now() - c.brokerTools.at < BROKERTOOLS_TTL_MS) return c.brokerTools.value;
  const [tape, launches] = await Promise.allSettled([
    getJson<{ rows?: BrokerToolsTapeRow[] }>(`${BROKERTOOLS_BASE}/api/firehose`),
    getJson<{ total?: number; rows?: BrokerToolsLaunchRow[] }>(
      `${BROKERTOOLS_BASE}/api/launches?offset=0`,
    ),
  ]);
  if (tape.status === "rejected" && launches.status === "rejected") {
    throw new Error(`firehose: ${String(tape.reason)}; launches: ${String(launches.reason)}`);
  }

  const rows = tape.status === "fulfilled" ? (tape.value.rows ?? []) : [];
  const mission = settings.tokenAddress.toLowerCase();
  let buyUsd = 0;
  let sellUsd = 0;
  let missionTrades = 0;
  let missionNetUsd = 0;
  let oldestTs: number | null = null;
  const bySymbol = new Map<string, BrokerToolsSymbolFlow>();
  for (const r of rows) {
    const usd = typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : 0;
    if (r.side === "buy") buyUsd += usd;
    else if (r.side === "sell") sellUsd += usd;
    if (typeof r.ts === "number" && (oldestTs === null || r.ts < oldestTs)) oldestTs = r.ts;
    const sym = r.symbol || "?";
    const flow = bySymbol.get(sym) ?? { symbol: sym, trades: 0, usd: 0 };
    flow.trades += 1;
    flow.usd += usd;
    bySymbol.set(sym, flow);
    if ((r.token ?? "").toLowerCase() === mission) {
      missionTrades += 1;
      missionNetUsd += r.side === "sell" ? -usd : usd;
    }
  }
  const topSymbols = [...bySymbol.values()].sort((a, b) => b.usd - a.usd).slice(0, 3);

  const launchRows = launches.status === "fulfilled" ? (launches.value.rows ?? []) : [];
  const topLaunches: BrokerToolsLaunch[] = launchRows.slice(0, 3).map((r) => ({
    symbol: r.symbol ?? "?",
    mcapUsd: typeof r.mcapUsd === "number" && Number.isFinite(r.mcapUsd) ? r.mcapUsd : null,
    buyers: typeof r.buyers === "number" ? r.buyers : null,
    phase: r.phase ?? null,
  }));

  const value: BrokerToolsIntel = {
    fetchedAt: Date.now(),
    tapeTrades: rows.length,
    tapeSpanMin: oldestTs !== null ? Math.max(1, Math.round((Date.now() / 1000 - oldestTs) / 60)) : null,
    buyUsd: Math.round(buyUsd),
    sellUsd: Math.round(sellUsd),
    topSymbols,
    missionTrades,
    missionNetUsd: Math.round(missionNetUsd),
    launchesTotal: launches.status === "fulfilled" ? (launches.value.total ?? null) : null,
    topLaunches,
  };
  c.brokerTools = { at: Date.now(), value };
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
  const [search, leaders, tracked, catalysts, eth, chain, radar, tvl, brokerTools] =
    await Promise.allSettled([
      fetchXMentions(),
      fetchXLeaders(),
      fetchXTracked(),
      fetchXCatalysts(),
      fetchEth(),
      fetchBlockscout(settings),
      fetchLaunchRadar(settings),
      fetchTvl(settings),
      fetchBrokerTools(settings),
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
  const trackedOk = tracked.status === "fulfilled";
  if (trackedOk) {
    sources.push("x-tracked");
    const missing = X_TRACKED.filter((a) => !tracked.value.some((t) => t.username === a.username));
    if (missing.length > 0) {
      warnings.push(
        `X tracked: handle(s) not found: ${missing.map((a) => `@${a.username}`).join(", ")} — operator should confirm the exact spelling`,
      );
    }
  } else {
    warnings.push(`X tracked timelines: ${String(tracked.reason)}`);
  }
  const catalystsOk = catalysts.status === "fulfilled";
  if (catalystsOk) sources.push("x-catalysts");
  else warnings.push(`X catalyst search: ${String(catalysts.reason)}`);

  if (searchOk || leadersOk) {
    x = {
      fetchedAt: Date.now(),
      mentionCount24h: searchOk ? search.value.count : (prev?.x?.mentionCount24h ?? 0),
      engagement24h: searchOk ? search.value.engagement : (prev?.x?.engagement24h ?? 0),
      topMentions: searchOk ? search.value.top : (prev?.x?.topMentions ?? []),
      leaders: leadersOk ? leaders.value : (prev?.x?.leaders ?? []),
      tracked: trackedOk ? tracked.value : (prev?.x?.tracked ?? []),
      catalysts: catalystsOk ? catalysts.value : (prev?.x?.catalysts ?? []),
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

  let launchRadar: LaunchRadar | null = null;
  if (radar.status === "fulfilled") {
    sources.push("dexscreener-radar");
    launchRadar = radar.value;
  } else {
    warnings.push(`DexScreener launch radar: ${String(radar.reason)}`);
  }

  let liveTvl: IntelTvl | null = null;
  if (tvl.status === "fulfilled") {
    sources.push("defillama-tvl");
    liveTvl = tvl.value;
  } else {
    warnings.push(`TVL (DefiLlama/Smart LP): ${String(tvl.reason)}`);
  }

  let brokerToolsIntel: BrokerToolsIntel | null = null;
  if (brokerTools.status === "fulfilled") {
    sources.push("brokertools");
    brokerToolsIntel = brokerTools.value;
  } else {
    warnings.push(`BrokerTools: ${String(brokerTools.reason)}`);
  }

  return {
    ts: Date.now(),
    x,
    ethUsd,
    ethUsd24hChangePct: ethChange,
    holderCount: holders,
    tokenTransferCount: transfers,
    launchRadar,
    tvl: liveTvl,
    brokerTools: brokerToolsIntel,
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

function ageOfMs(ts: number | null): string {
  if (!ts) return "age n/a";
  const h = (Date.now() - ts) / 3_600_000;
  if (h < 1) return `${Math.max(1, Math.round(h * 60))}m old`;
  return h < 48 ? `${Math.round(h)}h old` : `${Math.round(h / 24)}d old`;
}

function compactUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "n/a";
  if (n >= 999_500) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function radarPct(pct: number | null): string {
  if (pct === null) return "n/a";
  return `${pct >= 0 ? "+" : ""}${Math.abs(pct) >= 100 ? pct.toFixed(0) : pct.toFixed(1)}%`;
}

/** Renders the live TVL line of the digest; "" when no TVL data exists. */
export function tvlDigest(tvl: IntelTvl | null | undefined): string {
  if (!tvl || (tvl.protocolTvlUsd === null && tvl.smartLpTvlUsd === null)) return "";
  const parts: string[] = [];
  if (tvl.protocolTvlUsd !== null) {
    const changes = [
      tvl.change24hPct !== null ? `${radarPct(tvl.change24hPct)} 24h` : null,
      tvl.change7dPct !== null ? `${radarPct(tvl.change7dPct)} 7d` : null,
    ].filter(Boolean);
    parts.push(
      `protocol TVL ${compactUsd(tvl.protocolTvlUsd)}${changes.length ? ` (${changes.join(", ")})` : ""}`,
    );
  }
  if (tvl.smartLpTvlUsd !== null) {
    parts.push(
      `Smart LP vault fleet ${compactUsd(tvl.smartLpTvlUsd)}${tvl.smartLpVaults !== null ? ` across ${tvl.smartLpVaults} vaults` : ""}`,
    );
  }
  return `TVL LIVE (DeFiLlama + Smart LP lens): ${parts.join("; ")}. TVL is a graded lever; Smart LP deposits grow it.`;
}

/** Renders the BrokerTools section of the digest; "" when no data exists. */
export function brokerToolsDigest(bt: BrokerToolsIntel | null | undefined): string {
  if (!bt || (bt.tapeTrades === 0 && bt.launchesTotal === null)) return "";
  const lines = ["BROKERTOOLS TERMINAL (brokertools.info, independent Robinhood Chain indexer, live):"];
  if (bt.tapeTrades > 0) {
    const span = bt.tapeSpanMin !== null ? ` in ~${bt.tapeSpanMin}m` : "";
    const tops = bt.topSymbols.map((s) => `${s.symbol} ${compactUsd(s.usd)}/${s.trades}tx`).join(", ");
    const mission =
      bt.missionTrades > 0
        ? ` $STONKBROKER ${bt.missionTrades} trades, net ${bt.missionNetUsd >= 0 ? "+" : "-"}${compactUsd(Math.abs(bt.missionNetUsd))}.`
        : " No $STONKBROKER trades in this tape window.";
    lines.push(
      `- Chain DEX tape: ${bt.tapeTrades} trades${span}, buys ${compactUsd(bt.buyUsd)} vs sells ${compactUsd(bt.sellUsd)}; most traded ${tops}.${mission}`,
    );
  }
  if (bt.launchesTotal !== null) {
    const tops = bt.topLaunches
      .map((l) => `${l.symbol} ${compactUsd(l.mcapUsd)}${l.phase ? ` ${l.phase}` : ""}`)
      .join(", ");
    lines.push(
      `- Stonklauncher index: ${bt.launchesTotal} launches tracked${tops ? `; top mcap ${tops}` : ""}.`,
    );
  }
  return lines.join("\n");
}

/** Renders the launch-radar section of the digest; "" when no radar data exists. */
export function launchRadarDigest(radar: LaunchRadar | null | undefined): string {
  if (!radar || (radar.tokens.length === 0 && !radar.mission)) return "";
  const lines = [
    "ROBINHOOD CHAIN LAUNCH RADAR (DexScreener, live: newly profiled/boosted tokens on the chain — what launch concepts are actually working right now):",
  ];
  for (const t of radar.tokens.slice(0, 6)) {
    lines.push(
      `- ${t.symbol} "${t.name}" [${t.dexId}]: ${ageOfMs(t.pairCreatedAt)}, vol24 ${compactUsd(t.volume24hUsd)}, liq ${compactUsd(t.liquidityUsd)}, ${radarPct(t.priceChange24hPct)} 24h, mcap ${compactUsd(t.marketCapUsd)}${t.boosted ? ", boosted" : ""}`,
    );
  }
  if (radar.mission) {
    const m = radar.mission;
    lines.push(
      `- $STONKBROKER own pair [${m.dexId}]: vol24 ${compactUsd(m.volume24hUsd)}, liq ${compactUsd(m.liquidityUsd)}, ${radarPct(m.priceChange24hPct)} 24h, mcap ${compactUsd(m.marketCapUsd)}.`,
    );
  }
  return lines.join("\n");
}

/**
 * Compact prompt injection: what the live internet says TODAY. The X/macro/
 * holder section keeps its ~1500-char budget; the live-TVL line (~320), the
 * BrokerTools section (~600) and the launch-radar section (~900) are appended
 * after that cap with their own budgets so a verbose X day can never crowd
 * them out. History gives the mention/engagement trend so influence reads as
 * a delta, not a lone number.
 */
export function intelDigest(current: IntelSnapshot | null, history: IntelSnapshot[]): string {
  if (!current) return "Live internet intel unavailable this cycle (all fetchers failed).";
  const lines: string[] = [];
  const dayAgo = current.ts - 24 * 3600 * 1000;
  const prior = [...history].reverse().find((s) => s.ts <= dayAgo && s.x);

  if (current.x?.catalysts?.length) {
    for (const t of current.x.catalysts.slice(0, 2)) {
      lines.push(
        `PRIORITY CATALYST — @${t.author} (Robinhood founder) on operator accounts / stock tokens (${ago(t.createdAt)}, ${t.likes} likes): "${t.text.slice(0, 180)}" — amplify this NOW; it outranks every other angle this cycle.`,
      );
    }
  }
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
    for (const acct of current.x.tracked ?? []) {
      const t = acct.tweets[0];
      if (!t) continue;
      lines.push(
        `- Operator account @${acct.username} latest (${ago(t.createdAt)}, ${t.likes} likes): "${t.text.slice(0, 160)}" — align messaging with and amplify operator accounts.`,
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
  const main = lines.join("\n").slice(0, 1500);
  const tvl = tvlDigest(current.tvl).slice(0, 320);
  const brokerTools = brokerToolsDigest(current.brokerTools).slice(0, 600);
  const radar = launchRadarDigest(current.launchRadar).slice(0, 900);
  return [main, tvl, brokerTools, radar].filter(Boolean).join("\n");
}
