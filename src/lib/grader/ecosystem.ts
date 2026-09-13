import { createPublicClient, http } from "viem";

/**
 * Ecosystem trading volume: every tape that feeds StonkBrokers fees, in one
 * number (operator directive 2026-09-13: "all token trading volume on
 * StonkBrokers ecosystem tokens, including $STONKBROKER, all launcher tokens
 * and all Special Projects tokens").
 *
 *  1. $STONKBROKER itself: the DexScreener base-pair volume the grader already
 *     reads (passed in, so the two numbers can never disagree).
 *  2. Special Projects, counted in FULL: UP, YARD, WALL, MANCER, DERP, STRIKE.
 *     Every DexScreener pair where the token is the base leg.
 *  3. Every Stonk Launcher token, counted in FULL: the official launcher grid
 *     (stonkbrokers.cash/api/launcher/tokens, sorted by volume) lists each
 *     token with its 24h volume, curve trades included. Graduated tokens are
 *     re-read from DexScreener so secondary pools count too; curve-phase
 *     tokens keep the grid number. $LAURA is a launcher token and lands here.
 *  4. Smart LP pools, counted by SHARE: every registered Safety Deposit Box
 *     Smart LP vault sits on a canonical Uniswap v3 pool and skims 10% of the
 *     fees its position earns. A pool's volume is attributed as
 *     poolVolume24h x (vault TVL / pool liquidity), so the WETH/USDG vault with
 *     a few dollars in a $27M pool contributes cents while the STONKBROKER and
 *     meme vaults that hold real pool share contribute real volume. Registry
 *     driven (SmartLpLens.viewAll) so new vaults are covered with no code change.
 *
 * Pairs are deduped by address across every leg, so a token that is both a
 * launcher token and a Smart LP pool base is counted once.
 */

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const REGISTRY = "0xE8749183Fbf6A657EB58B3a4D3E4B9Cc09560146" as const;
const LENS = "0x754Bf8479630bbC22aA7b5E9742156ce89dD3D4d" as const;
const DEX = "https://api.dexscreener.com";
const LAUNCHER_GRID = "https://www.stonkbrokers.cash/api/launcher/tokens";
const TIMEOUT_MS = 15_000;
const PAIRS_PER_CALL = 30;
const TOKENS_PER_CALL = 30;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/** Special Projects on Robinhood Chain (stonkbrokers.io/launcher/special-projects). */
export const ECOSYSTEM_TOKENS: ReadonlyArray<{ symbol: string; address: string }> = [
  { symbol: "UP", address: "0x57C0E45cB534413D1C20A4240955d6bB250BB4F1" },
  { symbol: "YARD", address: "0xE3FA12dA7fa026B21817f16622E8AE48fA785166" },
  { symbol: "WALL", address: "0xB03058B8A39f3967DF08d833682C1c99b29821B1" },
  { symbol: "MANCER", address: "0xc72F232a6869e6CF34dC06129AfFD07F8a2a246A" },
  { symbol: "DERP", address: "0x6543b7746Ca744C4bb2198191E71F40fF04C41B9" },
  { symbol: "STRIKE", address: "0x5aeD379A72BD2533371d153135c47d5EB61BaBc8" },
];

const lensAbi = [
  {
    type: "function",
    name: "viewAll",
    stateMutability: "view",
    inputs: [{ name: "registry", type: "address" }],
    outputs: [
      {
        type: "tuple[]",
        components: [
          { name: "vault", type: "address" },
          { name: "pool", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "symbol0", type: "string" },
          { name: "symbol1", type: "string" },
          { name: "decimals0", type: "uint8" },
          { name: "decimals1", type: "uint8" },
          { name: "mode", type: "uint8" },
          { name: "baseIsToken0", type: "bool" },
          { name: "poolFee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "spotTick", type: "int24" },
          { name: "positionId", type: "uint256" },
          { name: "totalSupply", type: "uint256" },
          { name: "totalValueQuote", type: "uint256" },
          { name: "tvOk", type: "bool" },
          { name: "capQuote", type: "uint256" },
          { name: "maxCapQuote", type: "uint256" },
          { name: "perfFeeBps", type: "uint16" },
          { name: "withdrawFeeBps", type: "uint16" },
          { name: "depositsPaused", type: "bool" },
          { name: "settled", type: "bool" },
          { name: "allBase", type: "bool" },
          { name: "lastRecenterAt", type: "uint64" },
          { name: "feeManager", type: "address" },
        ],
      },
    ],
  },
] as const;

interface DexPair {
  chainId?: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
}

export interface SmartLpPoolShare {
  pool: string;
  /** Combined TVL of every vault on this pool, USD. */
  vaultTvlUsd: number;
}

export interface EcosystemVolume {
  /** Everything: $STONKBROKER + Special Projects + launcher tokens + Smart LP share. */
  totalUsd: number;
  /** $STONKBROKER DEX volume (the grader's tokenDexVolume24hUsd, passed through). */
  stonkbrokerUsd: number;
  specialProjectsUsd: number;
  launcherTokensUsd: number;
  /** Special Projects + launcher tokens (every ecosystem token pair except $STONKBROKER). */
  ecosystemTokensUsd: number;
  smartLpAttributedUsd: number;
  /** Raw 24h volume across every Smart LP pool before share attribution (context only). */
  smartLpPoolsGrossUsd: number;
  /** Distinct pairs that contributed (excluding $STONKBROKER's own pairs). */
  pairCount: number;
  /** Launcher tokens with any 24h volume. */
  launcherTokenCount: number;
  smartLpPoolCount: number;
  warnings: string[];
}

interface GridToken {
  token: string;
  symbol: string;
  graduated: boolean;
  volume24hUsd: number | null;
}

/** Every launcher token with 24h volume, from the official grid (volume-sorted, so one page covers them). */
export async function fetchLauncherTokens(): Promise<GridToken[]> {
  const out: GridToken[] = [];
  for (let offset = 0; offset < 1200; offset += 300) {
    const res = await getJson<{ ok: boolean; tokens?: GridToken[]; hasMore?: boolean }>(
      `${LAUNCHER_GRID}?sort=volume&limit=300&offset=${offset}`,
    );
    const page = res.tokens ?? [];
    const live = page.filter((t) => (t.volume24hUsd ?? 0) > 0);
    out.push(...live);
    /* Sorted by volume: the first zero ends the useful part of the list. */
    if (live.length < page.length || !res.hasMore) break;
  }
  return out;
}

async function fetchPairsByTokens(chainSlug: string, addresses: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (let i = 0; i < addresses.length; i += TOKENS_PER_CALL) {
    const chunk = addresses.slice(i, i + TOKENS_PER_CALL);
    const res = await getJson<{ pairs?: DexPair[] | null }>(`${DEX}/latest/dex/tokens/${chunk.join(",")}`);
    for (const p of res.pairs ?? []) if (p.chainId === undefined || p.chainId === chainSlug) out.push(p);
  }
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json", "user-agent": "stonk-swarm/0.1" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Every Smart LP pool with the summed USD TVL of the vaults sitting on it. */
export async function fetchSmartLpPools(ethUsd: number): Promise<SmartLpPoolShare[]> {
  const client = createPublicClient({ transport: http(RPC_URL, { timeout: 12_000 }) });
  const views = await client.readContract({
    address: LENS,
    abi: lensAbi,
    functionName: "viewAll",
    args: [REGISTRY],
  });
  const byPool = new Map<string, number>();
  for (const v of views) {
    const quote = (v.baseIsToken0 ? v.token1 : v.token0).toLowerCase();
    const quoteDecimals = v.baseIsToken0 ? v.decimals1 : v.decimals0;
    const tvQuote = Number(v.totalValueQuote) / 10 ** quoteDecimals;
    // Quote is USDG (1:1) or WETH (ethUsd); anything else is unpriced here.
    const tvUsd = quote === USDG ? tvQuote : ethUsd > 0 ? tvQuote * ethUsd : 0;
    const pool = v.pool.toLowerCase();
    byPool.set(pool, (byPool.get(pool) ?? 0) + (v.tvOk ? tvUsd : 0));
  }
  return [...byPool.entries()].map(([pool, vaultTvlUsd]) => ({ pool, vaultTvlUsd }));
}

async function fetchPairsByAddress(chainSlug: string, addresses: string[]): Promise<DexPair[]> {
  const out: DexPair[] = [];
  for (let i = 0; i < addresses.length; i += PAIRS_PER_CALL) {
    const chunk = addresses.slice(i, i + PAIRS_PER_CALL);
    const res = await getJson<{ pairs?: DexPair[] | null }>(
      `${DEX}/latest/dex/pairs/${chainSlug}/${chunk.join(",")}`,
    );
    for (const p of res.pairs ?? []) out.push(p);
  }
  return out;
}

/**
 * 24h ecosystem volume. `tokenAddress` is $STONKBROKER: its pairs are skipped
 * in every other leg and its volume enters once as `stonkbrokerUsd`.
 * `ethUsd` prices WETH quoted vault TVL for the Smart LP share math.
 */
export async function fetchEcosystemVolume(
  chainSlug: string,
  tokenAddress: string,
  ethUsd: number,
  stonkbrokerUsd: number,
): Promise<EcosystemVolume> {
  const warnings: string[] = [];
  const excluded = tokenAddress.toLowerCase();
  const special = new Set(ECOSYSTEM_TOKENS.map((t) => t.address.toLowerCase()));
  const seen = new Set<string>();
  let specialProjectsUsd = 0;
  let launcherTokensUsd = 0;
  let launcherTokenCount = 0;
  let smartLpAttributedUsd = 0;
  let smartLpPoolsGrossUsd = 0;
  let smartLpPoolCount = 0;

  const isExcluded = (p: DexPair) =>
    p.baseToken.address.toLowerCase() === excluded || p.quoteToken.address.toLowerCase() === excluded;

  // 1. Special Projects in full (base leg only, so a token is never counted
  //    once per quote asset it trades against).
  const results = await Promise.allSettled(
    ECOSYSTEM_TOKENS.map((t) =>
      getJson<DexPair[]>(`${DEX}/token-pairs/v1/${chainSlug}/${t.address}`).then((pairs) => ({ t, pairs })),
    ),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      warnings.push(`Special Projects: ${String(r.reason)}`);
      continue;
    }
    const token = r.value.t.address.toLowerCase();
    for (const p of r.value.pairs) {
      const key = p.pairAddress.toLowerCase();
      if (seen.has(key) || isExcluded(p) || p.baseToken.address.toLowerCase() !== token) continue;
      seen.add(key);
      specialProjectsUsd += p.volume?.h24 ?? 0;
    }
  }

  // 2. Every launcher token with volume: DexScreener for graduated tokens
  //    (all pools), the grid's own number for curve-phase tokens or when
  //    DexScreener has no pair yet.
  const launcherTokens = new Set<string>();
  try {
    const grid = (await fetchLauncherTokens()).filter(
      (t) => t.token.toLowerCase() !== excluded && !special.has(t.token.toLowerCase()),
    );
    launcherTokenCount = grid.length;
    for (const t of grid) launcherTokens.add(t.token.toLowerCase());
    const graduated = grid.filter((t) => t.graduated);
    const dexByToken = new Map<string, number>();
    if (graduated.length > 0) {
      try {
        const pairs = await fetchPairsByTokens(chainSlug, graduated.map((t) => t.token));
        for (const p of pairs) {
          const key = p.pairAddress.toLowerCase();
          const base = p.baseToken.address.toLowerCase();
          if (seen.has(key) || isExcluded(p) || !launcherTokens.has(base)) continue;
          seen.add(key);
          dexByToken.set(base, (dexByToken.get(base) ?? 0) + (p.volume?.h24 ?? 0));
        }
      } catch (err) {
        warnings.push(`Launcher tokens on DexScreener: ${String(err)}`);
      }
    }
    for (const t of grid) {
      const dex = dexByToken.get(t.token.toLowerCase());
      launcherTokensUsd += dex !== undefined && dex > 0 ? dex : (t.volume24hUsd ?? 0);
    }
  } catch (err) {
    warnings.push(`Launcher grid: ${String(err)}`);
  }

  // 3. Smart LP pools by vault share of pool liquidity.
  try {
    const pools = await fetchSmartLpPools(ethUsd);
    smartLpPoolCount = pools.length;
    const tvlByPool = new Map(pools.map((p) => [p.pool, p.vaultTvlUsd]));
    const pairs = await fetchPairsByAddress(chainSlug, pools.map((p) => p.pool));
    for (const p of pairs) {
      const key = p.pairAddress.toLowerCase();
      const vol = p.volume?.h24 ?? 0;
      smartLpPoolsGrossUsd += vol;
      if (seen.has(key) || isExcluded(p)) continue;
      seen.add(key);
      // Pools on an ecosystem token that DexScreener lists quote-first were not
      // caught by the base-leg rules above; count those in full too.
      const base = p.baseToken.address.toLowerCase();
      const quote = p.quoteToken.address.toLowerCase();
      if (special.has(base) || special.has(quote)) {
        specialProjectsUsd += vol;
        continue;
      }
      if (launcherTokens.has(base) || launcherTokens.has(quote)) {
        launcherTokensUsd += vol;
        continue;
      }
      const liq = p.liquidity?.usd ?? 0;
      const tvl = tvlByPool.get(key) ?? 0;
      const share = liq > 0 ? Math.min(1, tvl / liq) : 0;
      smartLpAttributedUsd += vol * share;
    }
  } catch (err) {
    warnings.push(`Smart LP pools: ${String(err)}`);
  }

  const ecosystemTokensUsd = specialProjectsUsd + launcherTokensUsd;
  return {
    totalUsd: stonkbrokerUsd + ecosystemTokensUsd + smartLpAttributedUsd,
    stonkbrokerUsd,
    specialProjectsUsd,
    launcherTokensUsd,
    ecosystemTokensUsd,
    smartLpAttributedUsd,
    smartLpPoolsGrossUsd,
    pairCount: seen.size,
    launcherTokenCount,
    smartLpPoolCount,
    warnings,
  };
}
