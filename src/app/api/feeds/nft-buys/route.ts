import { createPublicClient, http, parseAbiItem, type Log } from "viem";
import { cached, feedError, feedResponse } from "@/lib/feeds/util";

/**
 * StonkBroker NFT buy feed  -  the OpenSea buybot's data source, served to the
 * swarm directly from chain. Seaport 1.6 is the only NFT marketplace on
 * Robinhood Chain, so every secondary broker sale emits OrderFulfilled there.
 *
 * Correctness rules inherited from the sales bot + DefiLlama adapter:
 *  - matchOrders emits TWO OrderFulfilled events per trade (listing leg +
 *    bid leg)  -  dedupe by (tx, tokenId), preferring the bid leg for price.
 *  - a failed log scan must never advance the cursor or shrink the feed;
 *    the last good sale list keeps serving.
 */

export const dynamic = "force-dynamic";

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const SEAPORT = "0x0000000000000068f116a894984e2db1123eb395" as const;
const BROKERS = "0x539cdd042c2f3d93ebc5be7dfff0c79f3b4fabf0"; // StonkBrokers collection
const CHUNK = 25_000n; // Seaport is unfiltered by collection, keep chunks light
const MAX_CHUNKS_PER_PASS = 3; // bound each request; the cursor carries progress
const COLD_LOOKBACK = 600_000n; // ~17h at ~10 blocks/s
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

/* Module state: cursor + accumulated sales. The cursor only advances after a
 * fully successful pass, so a mid-scan RPC failure replays the range. */
const state: { cursor: bigint; sales: Sale[] } = { cursor: 0n, sales: [] };

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

async function scan(): Promise<{ sales: Sale[]; headBlock: number; syncedTo: number }> {
  const head = await client.getBlockNumber();
  if (state.cursor === 0n) {
    state.cursor = head > COLD_LOOKBACK ? head - COLD_LOOKBACK - 1n : 0n;
  }
  if (state.cursor >= head) {
    return { sales: state.sales, headBlock: Number(head), syncedTo: Number(state.cursor) };
  }

  // Incremental scan: a bounded number of chunks per request so a cold sync
  // never blows the request budget (Seaport logs cannot be filtered by
  // collection, so chunks are heavy). The cursor advances ONLY after a chunk
  // fully succeeds; a failed chunk ends the pass and replays next time, so
  // no range is ever skipped and the feed never shrinks.
  const found: Array<Omit<Sale, "ts">> = [];
  for (let i = 0; i < MAX_CHUNKS_PER_PASS && state.cursor < head; i++) {
    const start = state.cursor + 1n;
    const end = start + CHUNK > head ? head : start + CHUNK;
    let logs;
    try {
      logs = await client.getLogs({
        address: SEAPORT,
        event: ORDER_FULFILLED,
        fromBlock: start,
        toBlock: end,
        strict: false,
      });
    } catch {
      break; // cursor stays at the last fully scanned chunk
    }
    for (const log of logs) {
      try {
        found.push(...decodeSaleCandidates(log as Log<bigint, number, false, typeof ORDER_FULFILLED>));
      } catch {
        /* undecodable variant: skip the log, never the pass */
      }
    }
    state.cursor = end;
  }

  // Timestamp only the (few) blocks that carried new sales.
  const blockTs = new Map<number, number>();
  for (const s of found) {
    if (!blockTs.has(s.block)) {
      const b = await client.getBlock({ blockNumber: BigInt(s.block) });
      blockTs.set(s.block, Number(b.timestamp) * 1000);
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
  return { sales: merged, headBlock: Number(head), syncedTo: Number(state.cursor) };
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
        sales: res.data.sales,
      },
      15,
    );
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "nft buys feed failed");
  }
}
