import { createPublicClient, http, parseAbiItem, type Address } from "viem";

/**
 * Safety Deposit Box flow: what the protocol actually receives from the
 * lockers (operator directive 2026-09-13: "protocol revenue on the website
 * also reflects data from safety deposit box flow which we receive").
 *
 * Every locker desk (Uniswap V3, Uniswap V4, up. CL, up. v2, token vesting)
 * takes a protocol cut on lock, on fee collection, on liquidity withdrawal
 * and on gauge payouts. The cut is paid, in the pool's own tokens, to ONE
 * ownerless contract: SafetyDepositClockInV3, the "Safety Deposit Clock In",
 * which hard-splits it 90% to activated brokers / 10% to the protocol wallet.
 *
 * DeFiLlama's StonkBrokers adapter sees most of these cuts but books only the
 * 10% protocol-wallet slice as revenue and files the 90% broker share as
 * supply-side (and it cannot see the 0.5% upfront-mode cuts at all, since
 * those never emit a locker event). So the DeFiLlama revenue figure the site
 * used to show carried at most a tenth of this flow.
 *
 * Measurement here is at the box itself, so nothing depends on which locker
 * event fired: every ERC-20 `Transfer(to = SafetyDepositClockInV3)` in the
 * window (the lockers and the up. v2 per-lock vaults are the senders), plus
 * the native ETH leg the box flushes (`EthFlushed`, the V4 locker's ETH
 * pairs). Amounts are priced in USD: WETH at the ETH mark, USDG at par,
 * $STONKBROKER at the grader's price, everything else at DexScreener's
 * deepest pair, then the official launcher grid (graduated launcher tokens
 * sit on up. DEX pools DexScreener does not index). A token with no price
 * contributes nothing and is counted in `unpricedTokens`, never guessed.
 *
 * Block windows come from a two-point block/time anchor (the chain runs a
 * steady ~10 blocks/s). Finished chunks are cached in memory so a cycle only
 * refetches the head chunk.
 */

const RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const DEX = "https://api.dexscreener.com";
const LAUNCHER_GRID = "https://www.stonkbrokers.cash/api/launcher/tokens";
const TIMEOUT_MS = 20_000;
const TOKENS_PER_CALL = 30;
const DAY_S = 86_400;
/** Blocks per getLogs call; the public RPC serves ~860k in one shot and refuses ~6M. */
const CHUNK = 400_000n;
/** Head-distance after which a chunk is treated as final and cached. */
const FINAL_LAG = 200n;
const PAUSE_MS = 200;

/** SafetyDepositClockInV3: every locker desk pays its protocol cut here. */
export const SDB_ROUTER: Address = "0x55642A3F10F1Af5145D3d59021B1D6b03BB8692c";
export const SDB_DESKS: ReadonlyArray<{ key: SdbDesk; label: string; address: Address }> = [
  { key: "v3", label: "Uniswap V3 locker", address: "0xFc96CF67eCC55bE4AdABc3AecBe6Ad6349f11223" },
  { key: "v4", label: "Uniswap V4 locker", address: "0x5a28ce098750f73bc9eC142D4bCE464E1A0BBdA6" },
  { key: "upcl", label: "up. CL locker", address: "0xc1AfA59e2aBC1C868C51a1F799a7578EaCfEa076" },
  { key: "upv2", label: "up. v2 locker", address: "0x21797736C25851A6102D196afbA78F978f589017" },
  { key: "vesting", label: "Token vesting locker", address: "0x2b4aD79DA7BD3bF340bBd2aD2039b149214e9Aa9" },
];
export type SdbDesk = "v3" | "v4" | "upcl" | "upv2" | "vesting";
/** `vaults` = up. v2 per-lock vault clones paying gauge rewards; `eth` = native ETH flushed by the box. */
export type SdbSource = SdbDesk | "vaults" | "eth";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/** Fallback if the box's weth() read fails. */
const WETH_FALLBACK = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const DEFAULT_PROTOCOL_BPS = 1000;

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ETH_FLUSHED = parseAbiItem("event EthFlushed(uint256 boosterAmount, uint256 protocolAmount)");
const routerAbi = [
  { type: "function", name: "PROTOCOL_BPS", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "weth", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;
const erc20Abi = [{ type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] }] as const;

export interface SafetyDepositFlow {
  /** Everything the box received in the window, USD (100% of the locker cuts). */
  flow24hUsd: number;
  flow7dUsd: number;
  /** The hard split inside the box. */
  brokersShare24hUsd: number;
  protocolWallet24hUsd: number;
  protocolBps: number;
  bySource24hUsd: Record<SdbSource, number>;
  transfers24h: number;
  transfers7d: number;
  /** Distinct tokens received in 7d that had no USD price (contributed nothing). */
  unpricedTokens: number;
  /** False when a 7d chunk failed: flow7dUsd undercounts. */
  complete7d: boolean;
  warnings: string[];
}

interface Inflow {
  block: bigint;
  /** ERC-20 address, or "eth" for the native leg. */
  token: string;
  value: bigint;
  source: SdbSource;
}

interface ChunkCache {
  inflows: Inflow[];
}

const chunkCache = new Map<string, ChunkCache>();
const decimalsCache = new Map<string, number>();

const client = createPublicClient({ transport: http(RPC_URL, { timeout: TIMEOUT_MS, retryCount: 2, retryDelay: 800 }) });

const DESK_BY_ADDRESS = new Map<string, SdbDesk>(SDB_DESKS.map((d) => [d.address.toLowerCase(), d.key]));

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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

async function fetchChunk(from: bigint, to: bigint): Promise<Inflow[]> {
  const [transfers, flushes] = await Promise.all([
    client.getLogs({ event: TRANSFER, args: { to: SDB_ROUTER }, fromBlock: from, toBlock: to }),
    client.getLogs({ address: SDB_ROUTER, event: ETH_FLUSHED, fromBlock: from, toBlock: to }),
  ]);
  const out: Inflow[] = [];
  for (const l of transfers) {
    /* ERC-721 Transfer shares this topic0 with a third indexed topic; those
     * logs (a lock NFT sent to the box) decode without args and are skipped. */
    const value = l.args?.value ?? 0n;
    if (value <= 0n || l.blockNumber == null || l.topics.length !== 3) continue;
    const from = String(l.args?.from ?? "").toLowerCase();
    out.push({ block: l.blockNumber, token: l.address.toLowerCase(), value, source: DESK_BY_ADDRESS.get(from) ?? "vaults" });
  }
  for (const l of flushes) {
    const value = (l.args?.boosterAmount ?? 0n) + (l.args?.protocolAmount ?? 0n);
    if (value <= 0n || l.blockNumber == null) continue;
    out.push({ block: l.blockNumber, token: "eth", value, source: "eth" });
  }
  return out;
}

/** One retry after a pause: the public RPC answers 429 under parallel load. */
async function fetchChunkRetry(from: bigint, to: bigint): Promise<Inflow[]> {
  try {
    return await fetchChunk(from, to);
  } catch {
    await sleep(2_500);
    return fetchChunk(from, to);
  }
}

/**
 * Inflows over [floor, head], chunk-aligned so finished chunks are reused
 * across cycles. Returns the inflows plus whether every chunk answered.
 */
async function scanInflows(floor: bigint, head: bigint, warnings: string[]): Promise<{ inflows: Inflow[]; complete: boolean }> {
  const inflows: Inflow[] = [];
  let complete = true;
  const firstChunk = (floor / CHUNK) * CHUNK;
  for (let start = firstChunk; start <= head; start += CHUNK) {
    const end = start + CHUNK - 1n;
    const key = start.toString();
    const isFinal = end + FINAL_LAG <= head;
    const cached = isFinal ? chunkCache.get(key) : undefined;
    let rows: Inflow[];
    if (cached) {
      rows = cached.inflows;
    } else {
      try {
        rows = await fetchChunkRetry(start, end < head ? end : head);
      } catch (err) {
        complete = false;
        warnings.push(`blocks ${start}-${end}: ${String(err).slice(0, 120)}`);
        await sleep(PAUSE_MS);
        continue;
      }
      if (isFinal) chunkCache.set(key, { inflows: rows });
      await sleep(PAUSE_MS);
    }
    for (const r of rows) if (r.block >= floor) inflows.push(r);
  }
  /* Keep the cache bounded to the window we ever ask for. */
  for (const key of chunkCache.keys()) if (BigInt(key) + CHUNK < firstChunk) chunkCache.delete(key);
  return { inflows, complete };
}

async function readDecimals(tokens: string[]): Promise<Map<string, number>> {
  const missing = tokens.filter((t) => !decimalsCache.has(t));
  if (missing.length > 0) {
    const results = await client.multicall({
      allowFailure: true,
      multicallAddress: "0xcA11bde05977b3631167028862bE2a173976CA11",
      contracts: missing.map((t) => ({ address: t as Address, abi: erc20Abi, functionName: "decimals" as const })),
    });
    results.forEach((r, i) => {
      if (r.status === "success") decimalsCache.set(missing[i], Number(r.result));
    });
  }
  return new Map(tokens.filter((t) => decimalsCache.has(t)).map((t) => [t, decimalsCache.get(t) as number]));
}

interface DexPair {
  chainId?: string;
  baseToken: { address: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
}

/** DexScreener price for each token: the deepest pair where the token is the base leg. */
async function dexPrices(tokens: string[], chainSlug: string, warnings: string[]): Promise<Map<string, number>> {
  const prices = new Map<string, number>();
  const depth = new Map<string, number>();
  for (let i = 0; i < tokens.length; i += TOKENS_PER_CALL) {
    const chunk = tokens.slice(i, i + TOKENS_PER_CALL);
    try {
      const res = await getJson<{ pairs?: DexPair[] | null }>(`${DEX}/latest/dex/tokens/${chunk.join(",")}`);
      for (const p of res.pairs ?? []) {
        if (p.chainId !== undefined && p.chainId !== chainSlug) continue;
        const token = p.baseToken.address.toLowerCase();
        const price = Number(p.priceUsd ?? 0);
        const liq = p.liquidity?.usd ?? 0;
        if (!(price > 0) || !chunk.includes(token)) continue;
        if (liq > (depth.get(token) ?? -1)) {
          depth.set(token, liq);
          prices.set(token, price);
        }
      }
    } catch (err) {
      warnings.push(`DexScreener prices: ${String(err).slice(0, 120)}`);
    }
  }
  return prices;
}

interface GridToken {
  token: string;
  priceUsd: number | null;
}

/**
 * Launcher grid prices for tokens DexScreener does not index (graduated
 * launcher tokens live on up. DEX pools). Volume-sorted pages, stop early
 * once every wanted token is seen.
 */
async function gridPrices(tokens: string[], warnings: string[]): Promise<Map<string, number>> {
  const wanted = new Set(tokens);
  const prices = new Map<string, number>();
  for (let offset = 0; offset < 1800 && wanted.size > 0; offset += 300) {
    let page: GridToken[];
    let hasMore: boolean;
    try {
      const res = await getJson<{ tokens?: GridToken[]; hasMore?: boolean }>(`${LAUNCHER_GRID}?sort=volume&limit=300&offset=${offset}`);
      page = res.tokens ?? [];
      hasMore = Boolean(res.hasMore);
    } catch (err) {
      warnings.push(`launcher grid prices: ${String(err).slice(0, 120)}`);
      break;
    }
    for (const t of page) {
      const addr = t.token.toLowerCase();
      if (wanted.has(addr) && (t.priceUsd ?? 0) > 0) {
        prices.set(addr, t.priceUsd as number);
        wanted.delete(addr);
      }
    }
    if (!hasMore || page.length === 0) break;
  }
  return prices;
}

export interface SdbPriceInputs {
  chainSlug: string;
  ethUsd: number;
  /** $STONKBROKER address and price, so the two never disagree with the grader. */
  stonkAddress: string;
  stonkPriceUsd: number;
}

export async function fetchSafetyDepositFlow(inputs: SdbPriceInputs): Promise<SafetyDepositFlow> {
  const warnings: string[] = [];

  const [routerBps, routerWeth] = await Promise.allSettled([
    client.readContract({ address: SDB_ROUTER, abi: routerAbi, functionName: "PROTOCOL_BPS" }),
    client.readContract({ address: SDB_ROUTER, abi: routerAbi, functionName: "weth" }),
  ]);
  const protocolBps = routerBps.status === "fulfilled" ? Number(routerBps.value) : DEFAULT_PROTOCOL_BPS;
  const weth = routerWeth.status === "fulfilled" ? String(routerWeth.value).toLowerCase() : WETH_FALLBACK;

  /* Two-point anchor: blocks per second from the head and a block ~1 day back. */
  const headBlock = await client.getBlock();
  const head = headBlock.number;
  const probe = head - 800_000n > 0n ? head - 800_000n : 1n;
  const probeBlock = await client.getBlock({ blockNumber: probe });
  const dt = Number(headBlock.timestamp - probeBlock.timestamp);
  const rate = dt > 0 ? Number(head - probe) / dt : 10;
  const blocksFor = (seconds: number) => BigInt(Math.round(seconds * rate));
  const floor24h = head - blocksFor(DAY_S);
  const floor7d = head - blocksFor(7 * DAY_S);

  const { inflows, complete } = await scanInflows(floor7d > 0n ? floor7d : 1n, head, warnings);

  const tokens = [...new Set(inflows.filter((i) => i.token !== "eth").map((i) => i.token))];
  const decimals = await readDecimals(tokens).catch((err) => {
    warnings.push(`decimals: ${String(err).slice(0, 120)}`);
    return new Map<string, number>();
  });
  const stonk = inputs.stonkAddress.toLowerCase();
  const prices = new Map<string, number>();
  if (inputs.ethUsd > 0) prices.set(weth, inputs.ethUsd);
  prices.set(USDG, 1);
  if (inputs.stonkPriceUsd > 0) prices.set(stonk, inputs.stonkPriceUsd);
  const unknown = tokens.filter((t) => !prices.has(t));
  if (unknown.length > 0) for (const [t, p] of await dexPrices(unknown, inputs.chainSlug, warnings)) prices.set(t, p);
  const stillUnknown = tokens.filter((t) => !prices.has(t));
  if (stillUnknown.length > 0) for (const [t, p] of await gridPrices(stillUnknown, warnings)) prices.set(t, p);

  const usdOf = (i: Inflow): number | null => {
    if (i.token === "eth") return inputs.ethUsd > 0 ? (Number(i.value) / 1e18) * inputs.ethUsd : null;
    const price = prices.get(i.token);
    const dec = decimals.get(i.token);
    if (price === undefined || dec === undefined) return null;
    return (Number(i.value) / 10 ** dec) * price;
  };

  const bySource24hUsd: Record<SdbSource, number> = { v3: 0, v4: 0, upcl: 0, upv2: 0, vesting: 0, vaults: 0, eth: 0 };
  let flow24hUsd = 0;
  let flow7dUsd = 0;
  let transfers24h = 0;
  const unpriced = new Set<string>();
  for (const i of inflows) {
    const usd = usdOf(i);
    if (usd === null) {
      unpriced.add(i.token);
      continue;
    }
    flow7dUsd += usd;
    if (i.block >= floor24h) {
      flow24hUsd += usd;
      transfers24h += 1;
      bySource24hUsd[i.source] += usd;
    }
  }
  if (unpriced.size > 0) warnings.push(`${unpriced.size} token(s) received with no USD price, counted as zero`);

  const round = (n: number) => Math.round(n * 100) / 100;
  for (const k of Object.keys(bySource24hUsd) as SdbSource[]) bySource24hUsd[k] = round(bySource24hUsd[k]);
  return {
    flow24hUsd: round(flow24hUsd),
    flow7dUsd: round(flow7dUsd),
    brokersShare24hUsd: round(flow24hUsd * (1 - protocolBps / 10_000)),
    protocolWallet24hUsd: round(flow24hUsd * (protocolBps / 10_000)),
    protocolBps,
    bySource24hUsd,
    transfers24h,
    transfers7d: inflows.length,
    unpricedTokens: unpriced.size,
    complete7d: complete,
    warnings,
  };
}

/**
 * Website protocol revenue = DeFiLlama revenue + the share of the Safety
 * Deposit Box flow DeFiLlama leaves out. The adapter already books the
 * protocol-wallet slice (PROTOCOL_BPS) as revenue, so only the broker share
 * is added; adding the whole flow would count that slice twice.
 */
export function revenueWithSafetyDeposit(llamaRevenueUsd: number, sdbFlowUsd: number, protocolBps: number): number {
  return llamaRevenueUsd + sdbFlowUsd * (1 - protocolBps / 10_000);
}
