import { createPublicClient, http } from "viem";

/**
 * Ecosystem trading volume: the tape that actually feeds StonkBrokers fees but
 * never shows up under the protocol's own DeFiLlama volume line.
 *
 *  1. Ecosystem tokens, counted in FULL: the Special Projects roster (UP, YARD,
 *     WALL, MANCER, DERP, STRIKE) plus LAURA. Every DexScreener pair where the
 *     token is the base leg.
 *  2. Smart LP pools, counted by SHARE: every registered Safety Deposit Box
 *     Smart LP vault sits on a canonical Uniswap v3 pool and skims 10% of the
 *     fees its position earns. A pool's volume is attributed as
 *     poolVolume24h x (vault TVL / pool liquidity), so the WETH/USDG vault with
 *     a few dollars in a $27M pool contributes cents while the STONKBROKER and
 *     meme vaults that hold real pool share contribute real volume. Registry
 *     driven (SmartLpLens.viewAll) so new vaults are covered with no code change.
 *
 * $STONKBROKER pairs are excluded here because that tape is already its own
 * metric (tokenDexVolume24hUsd). Pairs are deduped by address across both legs.
 */

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const REGISTRY = "0xE8749183Fbf6A657EB58B3a4D3E4B9Cc09560146" as const;
const LENS = "0x754Bf8479630bbC22aA7b5E9742156ce89dD3D4d" as const;
const DEX = "https://api.dexscreener.com";
const TIMEOUT_MS = 15_000;
const PAIRS_PER_CALL = 30;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

/** Ecosystem tokens on Robinhood Chain (stonkbrokers.io/launcher/special-projects + LAURA). */
export const ECOSYSTEM_TOKENS: ReadonlyArray<{ symbol: string; address: string }> = [
  { symbol: "UP", address: "0x57C0E45cB534413D1C20A4240955d6bB250BB4F1" },
  { symbol: "YARD", address: "0xE3FA12dA7fa026B21817f16622E8AE48fA785166" },
  { symbol: "WALL", address: "0xB03058B8A39f3967DF08d833682C1c99b29821B1" },
  { symbol: "MANCER", address: "0xc72F232a6869e6CF34dC06129AfFD07F8a2a246A" },
  { symbol: "DERP", address: "0x6543b7746Ca744C4bb2198191E71F40fF04C41B9" },
  { symbol: "STRIKE", address: "0x5aeD379A72BD2533371d153135c47d5EB61BaBc8" },
  { symbol: "LAURA", address: "0x70cb95920312c5dfd3cfc6652c9e044ce7b1350c" },
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
  /** Ecosystem token pairs (full) + Smart LP pool volume attributed by vault share. */
  totalUsd: number;
  ecosystemTokensUsd: number;
  smartLpAttributedUsd: number;
  /** Raw 24h volume across every Smart LP pool before share attribution (context only). */
  smartLpPoolsGrossUsd: number;
  /** Distinct pairs that contributed. */
  pairCount: number;
  smartLpPoolCount: number;
  warnings: string[];
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
 * 24h ecosystem volume. `excludeToken` is the protocol token itself: any pair
 * where it is base or quote is skipped because that tape is already counted
 * as token DEX volume. `ethUsd` prices WETH quoted vault TVL for the share math.
 */
export async function fetchEcosystemVolume(
  chainSlug: string,
  excludeToken: string,
  ethUsd: number,
): Promise<EcosystemVolume> {
  const warnings: string[] = [];
  const excluded = excludeToken.toLowerCase();
  const ecosystem = new Set(ECOSYSTEM_TOKENS.map((t) => t.address.toLowerCase()));
  const seen = new Set<string>();
  let ecosystemTokensUsd = 0;
  let smartLpAttributedUsd = 0;
  let smartLpPoolsGrossUsd = 0;
  let smartLpPoolCount = 0;

  const isExcluded = (p: DexPair) =>
    p.baseToken.address.toLowerCase() === excluded || p.quoteToken.address.toLowerCase() === excluded;

  // 1. Ecosystem tokens in full (base leg only, so a token is never counted
  //    once per quote asset it trades against).
  const results = await Promise.allSettled(
    ECOSYSTEM_TOKENS.map((t) =>
      getJson<DexPair[]>(`${DEX}/token-pairs/v1/${chainSlug}/${t.address}`).then((pairs) => ({ t, pairs })),
    ),
  );
  for (const r of results) {
    if (r.status === "rejected") {
      warnings.push(`Ecosystem tokens: ${String(r.reason)}`);
      continue;
    }
    const token = r.value.t.address.toLowerCase();
    for (const p of r.value.pairs) {
      const key = p.pairAddress.toLowerCase();
      if (seen.has(key) || isExcluded(p) || p.baseToken.address.toLowerCase() !== token) continue;
      seen.add(key);
      ecosystemTokensUsd += p.volume?.h24 ?? 0;
    }
  }

  // 2. Smart LP pools by vault share of pool liquidity.
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
      // caught by the base-leg rule above; count those in full too.
      if (ecosystem.has(p.baseToken.address.toLowerCase()) || ecosystem.has(p.quoteToken.address.toLowerCase())) {
        ecosystemTokensUsd += vol;
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

  return {
    totalUsd: ecosystemTokensUsd + smartLpAttributedUsd,
    ecosystemTokensUsd,
    smartLpAttributedUsd,
    smartLpPoolsGrossUsd,
    pairCount: seen.size,
    smartLpPoolCount,
    warnings,
  };
}
