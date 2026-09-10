import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import { cached, feedError, feedResponse } from "@/lib/feeds/util";

/**
 * StonkBroker NFT buy feed - the OpenSea buybot's data source, served to the
 * swarm directly from chain. Seaport 1.6 is the only NFT marketplace on
 * Robinhood Chain, so every secondary broker sale emits OrderFulfilled there.
 *
 * Correctness rules inherited from the sales bot + DefiLlama adapter:
 *  - matchOrders emits TWO OrderFulfilled events per trade (listing leg +
 *    bid leg) - dedupe by (tx, tokenId), preferring the bid leg for price.
 *  - a failed log scan must never advance a cursor or shrink the feed;
 *    the last good sale list keeps serving.
 *
 * Scan shape: broker sales are RARE (a handful per day), so a forward-only
 * cold scan starting hours back never reaches the newest sales before the
 * serverless instance recycles. Instead the module keeps a scanned window
 * [low, high]: each request extends high forward to head (cheap, incremental)
 * and, until enough sales are on the tape, extends low BACKWARD from head -
 * newest sales are found in the very first chunks.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395" as const;
const BROKERS = "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0"; // StonkBrokers collection
const CHUNK = 25_000n; // Seaport is unfiltered by collection, keep chunks light
const MAX_FWD_CHUNKS = 3; // forward catch-up budget per request
const MAX_BACK_CHUNKS = 4; // backward seed budget per request (~100k blocks)
const MIN_SEED = 8; // stop seeding once this many sales are on the tape
const MAX_BACKFILL = 3_000_000n; // ~3.5 days at ~10 blocks/s
const MAX_SALES = 40;

const ORDER_FULFILLED = parseAbiItem(
  "event OrderFulfilled(bytes32 orderHash, address indexed offerer, address indexed zone, address recipient, (uint8 itemType, address token, uint256 identifier, uint256 amount)[] offer, (uint8 itemType, address token, uint256 identifier, uint256 amount, address recipient)[] consideration)",
);

const client = createPublicClient({ transport: http(RPC_URL, { timeout: 12_000 }) });

type Sale = {
  tx: string;
  tokenId: string;
  priceEth: number;
  buyer: string;
  seller: string;
  block: number;
  ts: number; // unix ms
  leg: "bid" | "listing";
};

/* Module state: the contiguous scanned window [low, high] plus accumulated
 * sales. Bounds only move after a chunk fully succeeds, so a mid-scan RPC
 * failure replays the range and the feed never shrinks. */
const state: { high: bigint; low: bigint; sales: Sale[] } = { high: 0n, low: 0n, sales: [] };

type Item = { itemType: number; token: string; identifier: bigint; amount: bigint };

function decodeSaleCandidates(log: Log<bigint, number, false, typeof ORDER_FULFILLED>): Array<Omit<Sale, "ts">> {
  const { offerer, recipient, offer, consideration } = log.args;
  const offerItems = offer as readonly Item[];
  const considItems = consideration as readonly Item[];

  const isBroker = (i: Item) => i.token.toLowerCase() === BROKERS;
  const isCurrency = (i: Item) => i.itemType === 0 || i.itemType === 1; // native ETH or ERC20 (WETH bids)
  const sum = (items: readonly Item[]) =>
    items.filter(isCurrency).reduce((a, i) => a + i.amount, 0n);

  const out: Array<Omit<Sale, "ts">> = [];
  const nftsOffered = offerItems.filter(isBroker);
  const nftsReceived = considItems.filter(isBroker);

  if (nftsOffered.length > 0) {
    // Listing leg: seller offers the NFT, price is the consideration currency.
    const price = sum(considItems);
    for (const nft of nftsOffered) {
      out.push({
        tx: log.transactionHash,
        tokenId: nft.identifier.toString(),
        priceEth: Number(price) / 1e18,
        buyer: (recipient as string).toLowerCase(),
        seller: (offerer as string).toLowerCase(),
        block: Number(log.blockNumber),
        leg: "listing",
      });
    }
  }
  if (nftsReceived.length > 0) {
    // Bid leg: bidder offers currency, receives the NFT.
    const price = sum(offerItems);
    for (const nft of nftsReceived) {
      out.push({
        tx: log.transactionHash,
        tokenId: nft.identifier.toString(),
        priceEth: Number(price) / 1e18,
        buyer: (offerer as string).toLowerCase(),
        seller: (recipient as string).toLowerCase(),
        block: Number(log.blockNumber),
        leg: "bid",
      });
    }
  }
  return out;
}

async function scanRange(fromBlock: bigint, toBlock: bigint): Promise<Array<Omit<Sale, "ts">> | null> {
  let logs;
  try {
    logs = await client.getLogs({
      address: SEAPORT,
      event: ORDER_FULFILLED,
      fromBlock,
      toBlock,
      strict: false,
    });
  } catch {
    return null; // caller keeps its bound - the range replays next pass
  }
  const found: Array<Omit<Sale, "ts">> = [];
  for (const log of logs) {
    try {
      found.push(...decodeSaleCandidates(log as Log<bigint, number, false, typeof ORDER_FULFILLED>));
    } catch {
      /* undecodable variant: skip the log, never the pass */
    }
  }
  return found;
}

async function scan(): Promise<{ sales: Sale[]; headBlock: number; syncedTo: number; scannedFrom: number }> {
  const head = await client.getBlockNumber();
  if (state.high === 0n) {
    // Cold start: nothing scanned yet - the window is empty at head and the
    // backward seed below fills the tape from the newest blocks first.
    state.high = head;
    state.low = head + 1n;
  }

  const found: Array<Omit<Sale, "ts">> = [];
  const uniqueCount = () => {
    const keys = new Set(state.sales.map((s) => `${s.tx}:${s.tokenId}`));
    for (const c of found) keys.add(`${c.tx}:${c.tokenId}`);
    return keys.size;
  };

  // 1) Forward catch-up toward head (bounded).
  for (let i = 0; i < MAX_FWD_CHUNKS && state.high < head; i++) {
    const start = state.high + 1n;
    const end = start + CHUNK > head ? head : start + CHUNK;
    const got = await scanRange(start, end);
    if (got === null) break;
    found.push(...got);
    state.high = end;
  }

  // 2) Backward seed, newest-first, until the tape holds MIN_SEED sales or
  //    the bounded backfill window is exhausted (bounded chunks per request).
  const floor = head > MAX_BACKFILL ? head - MAX_BACKFILL : 0n;
  for (let i = 0; i < MAX_BACK_CHUNKS && state.low > floor && uniqueCount() < MIN_SEED; i++) {
    const end = state.low - 1n;
    const start = end - CHUNK + 1n > floor ? end - CHUNK + 1n : floor;
    const got = await scanRange(start, end);
    if (got === null) break;
    found.push(...got);
    state.low = start;
  }

  // Timestamp only the (few) blocks that carried new sales.
  const blockTs = new Map<number, number>();
  for (const s of found) {
    if (!blockTs.has(s.block)) {
      try {
        const b = await client.getBlock({ blockNumber: BigInt(s.block) });
        blockTs.set(s.block, Number(b.timestamp) * 1000);
      } catch {
        /* fall back below */
      }
    }
  }

  // Merge with history, dedupe by (tx, tokenId) preferring the bid leg.
  const byKey = new Map<string, Sale>();
  for (const s of state.sales) byKey.set(`${s.tx}:${s.tokenId}`, s);
  for (const c of found) {
    const key = `${c.tx}:${c.tokenId}`;
    const prev = byKey.get(key);
    if (!prev || (prev.leg === "listing" && c.leg === "bid")) {
      byKey.set(key, { ...c, ts: blockTs.get(c.block) ?? prev?.ts ?? Date.now() });
    }
  }
  const merged = [...byKey.values()].sort((a, b) => b.block - a.block).slice(0, MAX_SALES);

  state.sales = merged;
  return {
    sales: merged,
    headBlock: Number(head),
    syncedTo: Number(state.high),
    scannedFrom: Number(state.low),
  };
}

export async function GET() {
  try {
    const res = await cached("nft-buys", 20_000, scan);
    return feedResponse(
      {
        ok: true,
        stale: res.stale,
        updatedAt: res.at,
        collection: BROKERS,
        headBlock: res.data.headBlock,
        syncedTo: res.data.syncedTo,
        scannedFrom: res.data.scannedFrom,
        sales: res.data.sales,
      },
      15,
    );
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "nft buys feed failed");
  }
}
