import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * Stonklauncher onchain feed  -  the same Robinhood Chain launchpad data the
 * @StonkLauncher_BuyBot Telegram bot tracks: the live buy tape plus pad wide
 * aggregates, with launch ids resolved to token names via the floor snapshot.
 *
 * Sources (public stonkbrokers.io APIs):
 *   /api/safe-launch/buys    -  live SafeBuy tape (5s cache here)
 *   /api/safe-launch/stats   -  pad aggregates (60s)
 *   /api/safe-launch/floor   -  id -> name/symbol map (5 min, big payload)
 */

export const dynamic = "force-dynamic";

const BASE = "https://stonkbrokers.io/api/safe-launch";

type BuysPayload = {
  ok: boolean;
  headBlock?: number;
  buys?: Array<{
    key: string;
    id: number;
    buyer: string;
    eth: number;
    sym: string;
    mcapUsd: number | null;
    block: number;
    ageMs: number;
  }>;
};

type StatsPayload = {
  ok: boolean;
  ethUsd?: number;
  pad?: {
    launches: number;
    graduated: number;
    bonded: number;
    buys: number;
    sells: number;
    uniqueBuyers: number;
    grossBuyEth: number;
    taxEth: number;
    bondedRaiseEth: number;
  };
};

type FloorPayload = {
  rows?: Array<{ id: number; name: string; symbol: string; phase: string }>;
};

async function loadNames(): Promise<Map<number, { name: string; symbol: string; phase: string }>> {
  const floor = await getJson<FloorPayload>(`${BASE}/floor`, 15_000);
  const map = new Map<number, { name: string; symbol: string; phase: string }>();
  for (const r of floor.rows ?? []) map.set(r.id, { name: r.name, symbol: r.symbol, phase: r.phase });
  return map;
}

export async function GET() {
  try {
    const [buysRes, statsRes, namesRes] = await Promise.all([
      cached("launcher:buys", 5_000, () => getJson<BuysPayload>(`${BASE}/buys`)),
      cached("launcher:stats", 60_000, () => getJson<StatsPayload>(`${BASE}/stats`)),
      cached("launcher:names", 300_000, loadNames),
    ]);

    const names = namesRes.data;
    const fetchedAt = Math.min(buysRes.at, statsRes.at);
    const buys = (buysRes.data.buys ?? []).map((b) => {
      const meta = names.get(b.id);
      return {
        key: b.key,
        launchId: b.id,
        name: meta?.name ?? `Launch #${b.id}`,
        symbol: meta?.symbol ?? "",
        phase: meta?.phase ?? "",
        buyer: b.buyer,
        eth: b.eth,
        paidIn: b.sym,
        mcapUsd: b.mcapUsd,
        block: b.block,
        // Re-anchor the upstream age to this response so the client can
        // render a live clock without knowing when the tape was fetched.
        ts: fetchedAt - b.ageMs,
      };
    });

    const pad = statsRes.data.pad;
    return feedResponse({
      ok: true,
      stale: buysRes.stale || statsRes.stale,
      updatedAt: fetchedAt,
      ethUsd: statsRes.data.ethUsd ?? null,
      headBlock: buysRes.data.headBlock ?? null,
      buys,
      stats: pad
        ? {
            launches: pad.launches,
            graduated: pad.graduated,
            bonded: pad.bonded,
            buys: pad.buys,
            sells: pad.sells,
            uniqueBuyers: pad.uniqueBuyers,
            grossBuyEth: pad.grossBuyEth,
            taxEth: pad.taxEth,
            bondedRaiseEth: pad.bondedRaiseEth,
          }
        : null,
    });
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "launcher feed failed");
  }
}
