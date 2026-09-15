import { createPublicClient, http, parseAbiItem } from "viem";
import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * Stonklauncher onchain feed - the same launchpad data the
 * @StonkLauncher_BuyBot Telegram bot tracks: the live buy tape plus pad wide
 * aggregates, with launch ids resolved to token names via the floor snapshot.
 * Covers BOTH launcher chains since 2026-09-15: Robinhood Chain (4663) and
 * the Arbitrum One V3 lanes (42161). Every buy row carries `chainId` and the
 * chain seed runs one leg per chain, each on its own RPC.
 *
 * Sources (public stonkbrokers.io APIs):
 *   /api/safe-launch/buys    - live SafeBuy tape (5s cache here)
 *   /api/safe-launch/stats   - pad aggregates (60s)
 *   /api/safe-launch/floor   - id -> name/symbol map + pad registry (5 min)
 *
 * IMPORTANT: the upstream buys endpoint is a SHAKE FEED for the trading desk,
 * not a history - it serves only a ~5 minute ring buffer, so at quiet moments
 * it is legitimately empty. This route therefore keeps its own rolling tape:
 *  - every poll merges fresh upstream buys into a module level tape (never
 *    replaced by an empty upstream - the "never shrink the feed" rule), and
 *  - a cold instance seeds the tape straight from chain, scanning SafeBuy
 *    logs BACKWARDS from head across every pad (addresses and id offsets
 *    derived from the public floor payload), newest buys first.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const BASE = "https://stonkbrokers.io/api/safe-launch";
const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const ARB_RPC_URL = process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const ROBINHOOD_CHAIN_ID = 4663;
const ARBITRUM_CHAIN_ID = 42161;
const CHAIN_LABEL: Record<number, string> = {
  [ROBINHOOD_CHAIN_ID]: "Robinhood Chain",
  [ARBITRUM_CHAIN_ID]: "Arbitrum One",
};
/** The V1 ETH pad (offset 0) - its rows carry no lane in the floor payload. */
const ETH_PAD_FALLBACK = "0xeca5726dae1e53365c37ffc02369d947a91d71f9";

const SAFE_BUY = parseAbiItem(
  "event SafeBuy(uint256 indexed id, address indexed buyer, uint256 ethIn, uint256 taxPaid, uint256 taxBps, uint256 tokensOut, uint256 mcapUsd8)",
);

const client = createPublicClient({ transport: http(RPC_URL, { timeout: 12_000 }) });
const arbClient = createPublicClient({ transport: http(ARB_RPC_URL, { timeout: 12_000 }) });

/* ------------------------- upstream payload types ------------------------- */

type BuysPayload = {
  ok: boolean;
  headBlock?: number;
  buys?: Array<{
    key: string;
    id: number;
    buyer: string;
    eth: number;
    sym: string;
    /** 4663 Robinhood, 42161 Arbitrum One (absent on older upstream builds). */
    chainId?: number;
    mcapUsd: number | null;
    block: number;
    ageMs: number;
  }>;
};

type StatsPayload = {
  ok: boolean;
  ethUsd?: number;
  pad?: {
    address?: string;
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
  rows?: Array<{
    id: number;
    name: string;
    symbol: string;
    phase: string;
    lane?: {
      pad?: string;
      launchId?: number;
      quoteSymbol?: string;
      quoteDecimals?: number;
      /** Set on Arbitrum One lanes; Robinhood lanes omit it. */
      chainId?: number;
    } | null;
  }>;
};

/* --------------------------- floor derived maps --------------------------- */

type PadMeta = { offset: number; sym: string; decimals: number; chainId: number };
type FloorMaps = {
  names: Map<number, { name: string; symbol: string; phase: string }>;
  pads: Map<string, PadMeta>;
};

async function loadFloorMaps(): Promise<FloorMaps> {
  const floor = await getJson<FloorPayload>(`${BASE}/floor`, 15_000);
  const names = new Map<number, { name: string; symbol: string; phase: string }>();
  const pads = new Map<string, PadMeta>();
  pads.set(ETH_PAD_FALLBACK, { offset: 0, sym: "ETH", decimals: 18, chainId: ROBINHOOD_CHAIN_ID });
  for (const r of floor.rows ?? []) {
    names.set(r.id, { name: r.name, symbol: r.symbol, phase: r.phase });
    const lane = r.lane;
    if (lane?.pad && typeof lane.launchId === "number") {
      pads.set(lane.pad.toLowerCase(), {
        offset: r.id - lane.launchId,
        sym: lane.quoteSymbol ?? "ETH",
        decimals: lane.quoteDecimals ?? 18,
        chainId: lane.chainId ?? ROBINHOOD_CHAIN_ID,
      });
    }
  }
  return { names, pads };
}

/* ----------------------------- rolling tape ------------------------------ */

type TapeRow = {
  key: string;
  launchId: number;
  buyer: string;
  eth: number;
  paidIn: string;
  chainId: number;
  mcapUsd: number | null;
  block: number;
  ts: number;
};

const MAX_TAPE = 40;
const SEED_TARGET = 12;
const SEED_CHUNK = 40_000n; // SafeBuy is pad-filtered: chunks are light
const SEED_CHUNKS_PER_PASS = 4;
const SEED_TS_LOOKUPS = 20;

/** Module tape: grows from upstream polls + the chain seed, newest first.
 * An empty upstream poll never shrinks it. */
const tape = new Map<string, TapeRow>();

/** Per chain backward seed cursor: oldest block covered (0n = not started). */
type SeedLeg = { chainId: number; client: typeof client; low: bigint; head: bigint; maxBack: bigint };
const SEED_LEGS: SeedLeg[] = [
  // ~10 blocks/s on Robinhood: 1M blocks ~ 28h.
  { chainId: ROBINHOOD_CHAIN_ID, client, low: 0n, head: 0n, maxBack: 1_000_000n },
  // ~4 blocks/s on Arbitrum One: 400k blocks ~ 28h.
  { chainId: ARBITRUM_CHAIN_ID, client: arbClient, low: 0n, head: 0n, maxBack: 400_000n },
];

function pushRow(row: TapeRow) {
  if (!tape.has(row.key)) tape.set(row.key, row);
}

/** Newest first across chains: block heights are not comparable between
 * Robinhood and Arbitrum, so timestamps order the tape and block only breaks
 * ties inside one chain. */
function newestFirst(a: TapeRow, b: TapeRow): number {
  if (a.ts !== b.ts) return b.ts - a.ts;
  return a.chainId === b.chainId ? b.block - a.block : 0;
}

function trimTape() {
  if (tape.size <= MAX_TAPE) return;
  const rows = [...tape.values()].sort(newestFirst);
  tape.clear();
  for (const r of rows.slice(0, MAX_TAPE)) tape.set(r.key, r);
}

/** Backward chain seed, one leg per chain: scan SafeBuy logs newest-first on
 * that chain's pads until the tape holds SEED_TARGET rows from it or the
 * bounded backfill window is exhausted. Each request does at most
 * SEED_CHUNKS_PER_PASS getLogs calls per leg; progress persists in module
 * state so warm instances deepen instead of rescanning. A failing leg never
 * blocks the other chain's tape. */
async function seedLeg(leg: SeedLeg, pads: Map<string, PadMeta>) {
  const legPads = [...pads.entries()].filter(([, m]) => m.chainId === leg.chainId).map(([a]) => a);
  if (legPads.length === 0) return;
  const have = [...tape.values()].filter((r) => r.chainId === leg.chainId).length;
  if (have >= SEED_TARGET) return;
  if (leg.head === 0n) {
    leg.head = await leg.client.getBlockNumber();
    leg.low = leg.head + 1n;
  }
  const floor = leg.head > leg.maxBack ? leg.head - leg.maxBack : 0n;
  const found: Array<Omit<TapeRow, "ts"> & { ts?: number }> = [];
  for (let i = 0; i < SEED_CHUNKS_PER_PASS && leg.low > floor && have + found.length < SEED_TARGET; i++) {
    const end = leg.low - 1n;
    const start = end - SEED_CHUNK + 1n > floor ? end - SEED_CHUNK + 1n : floor;
    let logs;
    try {
      logs = await leg.client.getLogs({
        address: legPads as `0x${string}`[],
        event: SAFE_BUY,
        fromBlock: start,
        toBlock: end,
        strict: false,
      });
    } catch {
      break; // leg.low stays - the range replays next pass
    }
    for (const log of logs) {
      const meta = pads.get(log.address.toLowerCase());
      if (!meta || !log.args.id || !log.args.buyer) continue;
      found.push({
        key: `${log.transactionHash}:${log.logIndex}`,
        launchId: meta.offset + Number(log.args.id),
        buyer: (log.args.buyer as string).toLowerCase(),
        eth: Number(log.args.ethIn ?? 0n) / 10 ** meta.decimals,
        paidIn: meta.sym,
        chainId: leg.chainId,
        mcapUsd: log.args.mcapUsd8 != null ? Number(log.args.mcapUsd8) / 1e8 : null,
        block: Number(log.blockNumber),
      });
    }
    leg.low = start;
  }
  if (found.length === 0) return;

  // Real timestamps for the newest seeded blocks (bounded); older rows reuse
  // the nearest anchor so the age column stays sane without O(n) getBlock.
  found.sort((a, b) => b.block - a.block);
  const kept = found.slice(0, MAX_TAPE);
  const blocks = [...new Set(kept.map((r) => r.block))];
  const blockTs = new Map<number, number>();
  for (const b of blocks.slice(0, SEED_TS_LOOKUPS)) {
    try {
      const blk = await leg.client.getBlock({ blockNumber: BigInt(b) });
      blockTs.set(b, Number(blk.timestamp) * 1000);
    } catch {
      break;
    }
  }
  let lastTs = Date.now();
  for (const r of kept) {
    lastTs = blockTs.get(r.block) ?? lastTs;
    pushRow({ ...r, ts: lastTs });
  }
  trimTape();
}

async function seedFromChain(pads: Map<string, PadMeta>) {
  if (tape.size >= SEED_TARGET * SEED_LEGS.length) return;
  await Promise.all(
    SEED_LEGS.map((leg) => seedLeg(leg, pads).catch(() => undefined)),
  );
}

/* --------------------------------- route --------------------------------- */

async function loadTape(): Promise<{ headBlock: number | null }> {
  // Upstream live window first (it carries seenAt precision the seed lacks).
  const up = await getJson<BuysPayload>(`${BASE}/buys`);
  const now = Date.now();
  for (const b of up.buys ?? []) {
    pushRow({
      key: b.key,
      launchId: b.id,
      buyer: b.buyer,
      eth: b.eth,
      paidIn: b.sym,
      chainId: b.chainId ?? ROBINHOOD_CHAIN_ID,
      mcapUsd: b.mcapUsd,
      block: b.block,
      ts: now - b.ageMs,
    });
  }
  trimTape();
  return { headBlock: up.headBlock ?? null };
}

export async function GET() {
  try {
    const [statsRes, mapsRes] = await Promise.all([
      cached("launcher:stats", 60_000, () => getJson<StatsPayload>(`${BASE}/stats`)),
      cached("launcher:maps", 300_000, loadFloorMaps),
    ]);
    const buysRes = await cached("launcher:buys", 5_000, async () => {
      const head = await loadTape();
      // Chain seed only when the accumulated tape is still thin (cold
      // instance or genuinely quiet floor) - bounded work per request.
      await seedFromChain(mapsRes.data.pads);
      return head;
    });

    const names = mapsRes.data.names;
    const buys = [...tape.values()]
      .sort(newestFirst)
      .map((b) => {
        const meta = names.get(b.launchId);
        return {
          key: b.key,
          launchId: b.launchId,
          name: meta?.name ?? `Launch #${b.launchId}`,
          symbol: meta?.symbol ?? "",
          phase: meta?.phase ?? "",
          buyer: b.buyer,
          eth: b.eth,
          paidIn: b.paidIn,
          chainId: b.chainId,
          chain: CHAIN_LABEL[b.chainId] ?? `chain ${b.chainId}`,
          mcapUsd: b.mcapUsd,
          block: b.block,
          ts: b.ts,
        };
      });

    const pad = statsRes.data.pad;
    return feedResponse({
      ok: true,
      stale: buysRes.stale || statsRes.stale,
      updatedAt: buysRes.at,
      ethUsd: statsRes.data.ethUsd ?? null,
      headBlock: buysRes.data.headBlock,
      chains: SEED_LEGS.map((l) => ({ chainId: l.chainId, label: CHAIN_LABEL[l.chainId] })),
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
