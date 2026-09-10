import { createPublicClient, http } from "viem";
import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * Smart LP feed - the Safety Deposit Box concentrated liquidity vault fleet
 * on Robinhood Uniswap v3, read through the SmartLpLens in ONE eth_call
 * (viewAll over the registry: ~180 vaults in ~600ms), then merged with the
 * public keeper activity ledger at stonkbrokers.io/api/locker/smartlp-activity
 * (compound / collect / recenter counts per vault).
 *
 * The dashboard section built on this focuses on the BALANCED BAND vaults
 * (mode 1): band = TWAP +-1200 ticks (~12.7% per side), keeper recenter fires
 * when the 30 min TWAP drifts within 240 ticks of a band edge, with a 6h
 * onchain cooldown. LAURA studies fee velocity, time in band, recenter
 * cadence and TVL per vault and proposes small algo adjustments (operator
 * approved) - this route is her raw data.
 *
 * Sources (public, unkeyed):
 *   Robinhood Chain RPC (public endpoint, ROBINHOOD_RPC_URL overrides)
 *   https://stonkbrokers.io/api/locker/smartlp-activity
 *   https://coins.llama.fi/prices/current/coingecko:ethereum (WETH quote -> USD)
 */

export const dynamic = "force-dynamic";

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const REGISTRY = "0xE8749183Fbf6A657EB58B3a4D3E4B9Cc09560146" as const;
const LENS = "0x754Bf8479630bbC22aA7b5E9742156ce89dD3D4d" as const;
const ACTIVITY_URL = "https://stonkbrokers.io/api/locker/smartlp-activity";
const LLAMA_ETH = "https://coins.llama.fi/prices/current/coingecko:ethereum";

/** Balanced band mechanics (immutable vault config, mirrored here for the UI). */
const RECENTER_TRIGGER_TICKS = 240;
const TOP_BB_ROWS = 12;

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

type VaultActivity = {
  compounds?: number;
  collects?: number;
  rebalances?: number;
  recent?: Array<{ t: string; block: number; ts: number }>;
};

type ActivityPayload = {
  updatedAt?: number;
  vaults?: Record<string, VaultActivity>;
};

export type SmartLpBbRow = {
  vault: string;
  base: string;
  quote: string;
  feePct: number;
  tvlUsd: number | null;
  /** Spot position inside the band, 0..100 (50 = centered). */
  bandPct: number;
  /** Half band width as a price percent (tick math). */
  halfWidthPct: number;
  /** Ticks from spot to the nearest band edge. */
  edgeTicks: number;
  /** Within the 240 tick recenter trigger distance. */
  nearEdge: boolean;
  compounds: number;
  recenters: number;
  lastActivityTs: number | null;
  lastRecenterAt: number | null;
  paused: boolean;
};

export type SmartLpData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  ethUsd: number | null;
  mechanics: {
    bandTicks: number;
    recenterTriggerTicks: number;
    recenterCooldownHours: number;
    perfFeeBps: number;
    withdrawFeeBps: number;
  };
  fleet: {
    vaults: number;
    bbVaults: number;
    tvlUsd: number;
    compounds: number;
    collects: number;
    recenters: number;
    activityAt: number | null;
  };
  bb: SmartLpBbRow[];
};

function tickToPct(ticks: number): number {
  return (Math.pow(1.0001, ticks) - 1) * 100;
}

async function load(): Promise<SmartLpData> {
  const client = createPublicClient({ transport: http(RPC_URL, { timeout: 12_000 }) });

  const [views, ethUsd, activity] = await Promise.all([
    client.readContract({ address: LENS, abi: lensAbi, functionName: "viewAll", args: [REGISTRY] }),
    getJson<{ coins?: Record<string, { price?: number }> }>(LLAMA_ETH)
      .then((r) => r.coins?.["coingecko:ethereum"]?.price ?? null)
      .catch(() => null),
    getJson<ActivityPayload>(ACTIVITY_URL, 12_000).catch(() => null),
  ]);

  const acts = activity?.vaults ?? {};
  let perfFeeBps = 1000;
  let withdrawFeeBps = 10;

  let fleetTvl = 0;
  let bbCount = 0;
  const bbRows: SmartLpBbRow[] = [];

  for (const v of views) {
    const quoteIdx = v.baseIsToken0 ? 1 : 0;
    const quoteSymbol = quoteIdx === 0 ? v.symbol0 : v.symbol1;
    const quoteDecimals = quoteIdx === 0 ? v.decimals0 : v.decimals1;
    const baseSymbol = quoteIdx === 0 ? v.symbol1 : v.symbol0;

    const tvQuote = v.tvOk ? Number(v.totalValueQuote) / Math.pow(10, quoteDecimals) : null;
    let tvlUsd: number | null = null;
    if (tvQuote !== null) {
      if (quoteSymbol === "USDG") tvlUsd = tvQuote;
      else if (quoteSymbol === "WETH" && ethUsd !== null) tvlUsd = tvQuote * ethUsd;
    }
    if (tvlUsd !== null) fleetTvl += tvlUsd;

    perfFeeBps = v.perfFeeBps;
    withdrawFeeBps = v.withdrawFeeBps;

    if (v.mode !== 1) continue;
    bbCount += 1;

    const lower = Number(v.tickLower);
    const upper = Number(v.tickUpper);
    const spot = Number(v.spotTick);
    const width = Math.max(1, upper - lower);
    const bandPct = Math.min(100, Math.max(0, ((spot - lower) / width) * 100));
    const edgeTicks = Math.max(0, Math.min(spot - lower, upper - spot));
    const act = acts[v.vault.toLowerCase()];
    const lastAct = act?.recent?.length ? act.recent[act.recent.length - 1]?.ts ?? null : null;

    bbRows.push({
      vault: v.vault,
      base: baseSymbol,
      quote: quoteSymbol,
      feePct: v.poolFee / 10_000,
      tvlUsd,
      bandPct: Math.round(bandPct * 10) / 10,
      halfWidthPct: Math.round(tickToPct(width / 2) * 10) / 10,
      edgeTicks,
      nearEdge: edgeTicks <= RECENTER_TRIGGER_TICKS,
      compounds: act?.compounds ?? 0,
      recenters: act?.rebalances ?? 0,
      lastActivityTs: lastAct ? lastAct * 1000 : null,
      lastRecenterAt: v.lastRecenterAt > 0n ? Number(v.lastRecenterAt) * 1000 : null,
      paused: v.depositsPaused,
    });
  }

  bbRows.sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));

  let compounds = 0;
  let collects = 0;
  let recenters = 0;
  for (const a of Object.values(acts)) {
    compounds += a.compounds ?? 0;
    collects += a.collects ?? 0;
    recenters += a.rebalances ?? 0;
  }

  return {
    ok: true,
    updatedAt: Date.now(),
    stale: false,
    ethUsd,
    mechanics: {
      bandTicks: 1200,
      recenterTriggerTicks: RECENTER_TRIGGER_TICKS,
      recenterCooldownHours: 6,
      perfFeeBps,
      withdrawFeeBps,
    },
    fleet: {
      vaults: views.length,
      bbVaults: bbCount,
      tvlUsd: Math.round(fleetTvl),
      compounds,
      collects,
      recenters,
      activityAt: activity?.updatedAt ?? null,
    },
    bb: bbRows.slice(0, TOP_BB_ROWS),
  };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("smartlp", 120_000, load);
    return feedResponse({ ...data, stale, updatedAt: at }, 60);
  } catch (err) {
    return feedError(String(err));
  }
}
