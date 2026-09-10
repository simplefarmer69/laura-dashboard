import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * BrokerTools feed - brokertools.info, an independent explorer and data
 * terminal for Robinhood Chain ("high context explorer", public, unkeyed),
 * proxied in one compact payload so the swarm and the console can watch the
 * chain-wide DEX trade tape and the Stonklauncher index without hitting the
 * site per consumer.
 *
 * Endpoints verified live (2026-09-10):
 *   https://brokertools.info/api/firehose          - ~120 most recent chain-wide
 *     DEX trades: token, symbol, side, amount, usd, priceUsd, venue
 *   https://brokertools.info/api/launches?offset=0 - Stonklauncher index:
 *     total launch count + rows sorted by mcap (symbol, mcapUsd, buyers, phase)
 */

export const dynamic = "force-dynamic";

const BASE = "https://brokertools.info";
const TAPE_ROWS = 40;
const LAUNCH_ROWS = 10;

type TapeRow = {
  token?: string;
  symbol?: string;
  ts?: number;
  side?: string;
  amount?: number;
  usd?: number;
  priceUsd?: number;
  venue?: string;
};

type LaunchRow = {
  id?: number;
  token?: string;
  symbol?: string;
  name?: string;
  mcapUsd?: number;
  buyers?: number;
  phase?: string;
};

export type BrokerToolsFeed = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  siteUrl: string;
  tape: {
    trades: number;
    buyUsd: number;
    sellUsd: number;
    rows: TapeRow[];
  };
  launches: {
    total: number | null;
    rows: LaunchRow[];
  };
};

async function load(): Promise<Omit<BrokerToolsFeed, "ok" | "updatedAt" | "stale">> {
  const [tape, launches] = await Promise.allSettled([
    getJson<{ rows?: TapeRow[] }>(`${BASE}/api/firehose`, 12_000),
    getJson<{ total?: number; rows?: LaunchRow[] }>(`${BASE}/api/launches?offset=0`, 12_000),
  ]);
  if (tape.status === "rejected" && launches.status === "rejected") {
    throw new Error(`firehose: ${String(tape.reason)}; launches: ${String(launches.reason)}`);
  }
  const rows = tape.status === "fulfilled" ? (tape.value.rows ?? []) : [];
  let buyUsd = 0;
  let sellUsd = 0;
  for (const r of rows) {
    const usd = typeof r.usd === "number" && Number.isFinite(r.usd) ? r.usd : 0;
    if (r.side === "buy") buyUsd += usd;
    else if (r.side === "sell") sellUsd += usd;
  }
  const launchRows = launches.status === "fulfilled" ? (launches.value.rows ?? []) : [];
  return {
    siteUrl: BASE,
    tape: {
      trades: rows.length,
      buyUsd: Math.round(buyUsd),
      sellUsd: Math.round(sellUsd),
      rows: rows.slice(0, TAPE_ROWS),
    },
    launches: {
      total: launches.status === "fulfilled" ? (launches.value.total ?? null) : null,
      rows: launchRows.slice(0, LAUNCH_ROWS),
    },
  };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("brokertools", 120_000, load);
    return feedResponse({ ok: true, updatedAt: at, stale, ...data }, 60);
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "brokertools feed failed");
  }
}
