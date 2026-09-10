import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * DeFiLlama feed  -  the protocol's public listing at
 * https://defillama.com/protocol/stonkbrokers, proxied in one compact payload
 * so the swarm (and the console) can track TVL, fees, revenue and the Anvil
 * AMM volume without hitting api.llama.fi directly.
 *
 * Sources (public, unkeyed):
 *   /protocol/stonkbrokers                          -  TVL history + chain TVLs
 *   /summary/fees/stonkbrokers                      -  daily fees series + totals
 *   /summary/fees/stonkbrokers?dataType=dailyRevenue - daily revenue series + totals
 *   /summary/dexs/clutch-anvil-amm                  -  Anvil AMM daily volume (secondary)
 *
 * DeFiLlama updates roughly hourly, so this proxy caches for 5 minutes with
 * the shared last good fallback (a failed upstream never shrinks the payload).
 */

export const dynamic = "force-dynamic";

const API = "https://api.llama.fi";
const PROTOCOL_URL = "https://defillama.com/protocol/stonkbrokers";
const MAX_POINTS = 180;

type ProtocolPayload = {
  currentChainTvls?: Record<string, number>;
  tvl?: Array<{ date: number; totalLiquidityUSD: number }>;
};

type SummaryPayload = {
  total24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  totalAllTime?: number | null;
  totalDataChart?: Array<[number, number]>;
};

/** One daily point: unix seconds + USD value. */
export type SeriesPoint = { t: number; usd: number };

export type DefillamaFeed = {
  ok: true;
  updatedAt: number;
  stale: boolean;
  protocolUrl: string;
  tvl: {
    currentUsd: number | null;
    stakingUsd: number | null;
    series: SeriesPoint[];
  };
  fees: {
    total24hUsd: number | null;
    total7dUsd: number | null;
    total30dUsd: number | null;
    cumulativeUsd: number | null;
    series: SeriesPoint[];
  };
  revenue: {
    total24hUsd: number | null;
    total7dUsd: number | null;
    cumulativeUsd: number | null;
    series: SeriesPoint[];
  };
  dexVolume: {
    name: string;
    total24hUsd: number | null;
    total7dUsd: number | null;
    cumulativeUsd: number | null;
    series: SeriesPoint[];
  };
};

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Keep the most recent MAX_POINTS daily points of a [ts, usd] chart. */
function chartSeries(chart: Array<[number, number]> | undefined): SeriesPoint[] {
  const rows = (chart ?? []).filter(
    (r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]),
  );
  return rows.slice(-MAX_POINTS).map(([t, usd]) => ({ t, usd }));
}

function tvlSeries(tvl: ProtocolPayload["tvl"]): SeriesPoint[] {
  const rows = (tvl ?? []).filter(
    (r) => r && Number.isFinite(r.date) && Number.isFinite(r.totalLiquidityUSD),
  );
  return rows.slice(-MAX_POINTS).map((r) => ({ t: r.date, usd: r.totalLiquidityUSD }));
}

async function load(): Promise<Omit<DefillamaFeed, "ok" | "updatedAt" | "stale">> {
  const [protocol, fees, revenue, dex] = await Promise.all([
    getJson<ProtocolPayload>(`${API}/protocol/stonkbrokers`, 15_000),
    getJson<SummaryPayload>(`${API}/summary/fees/stonkbrokers`, 15_000),
    getJson<SummaryPayload>(`${API}/summary/fees/stonkbrokers?dataType=dailyRevenue`, 15_000),
    getJson<SummaryPayload>(`${API}/summary/dexs/clutch-anvil-amm`, 15_000),
  ]);

  const chainTvls = protocol.currentChainTvls ?? {};

  return {
    protocolUrl: PROTOCOL_URL,
    tvl: {
      currentUsd: num(chainTvls["Robinhood Chain"]),
      stakingUsd: num(chainTvls["staking"]),
      series: tvlSeries(protocol.tvl),
    },
    fees: {
      total24hUsd: num(fees.total24h),
      total7dUsd: num(fees.total7d),
      total30dUsd: num(fees.total30d),
      cumulativeUsd: num(fees.totalAllTime),
      series: chartSeries(fees.totalDataChart),
    },
    revenue: {
      total24hUsd: num(revenue.total24h),
      total7dUsd: num(revenue.total7d),
      cumulativeUsd: num(revenue.totalAllTime),
      series: chartSeries(revenue.totalDataChart),
    },
    dexVolume: {
      name: "Clutch Anvil AMM",
      total24hUsd: num(dex.total24h),
      total7dUsd: num(dex.total7d),
      cumulativeUsd: num(dex.totalAllTime),
      series: chartSeries(dex.totalDataChart),
    },
  };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("defillama", 300_000, load);
    return feedResponse({ ok: true, updatedAt: at, stale, ...data }, 120);
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "defillama feed failed");
  }
}
