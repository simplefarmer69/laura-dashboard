import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";
import { DEFAULT_SETTINGS } from "@/lib/swarm/roster";

/**
 * Pair map feed - EVERY DexScreener pair for $STONKBROKER on Robinhood
 * Chain, one row per pool, so the swarm can finally answer the cafe bar
 * questions the single-row token tape cannot: which pairs are sub $5k dust
 * skewing liquidity weighted price, what the median pair depth really is,
 * and how concentrated the $5.9M headline liquidity actually is.
 *
 * Every row carries BOTH the headline liquidity and the vetted QUOTE SIDE
 * depth (headline liquidity is spoofable; quote side depth in a canonical
 * asset is not - the standing vetting rule). Rows are never dropped here,
 * unlike the token tape: the whole point is seeing the untrusted tail.
 *
 * All rows are chain 4663 by construction (the upstream endpoint is chain
 * scoped) - bridged deployments on other chains have different addresses
 * and never appear in this feed.
 *
 * Source (public, unkeyed):
 *   https://api.dexscreener.com/token-pairs/v1/robinhood/{token}
 */

export const dynamic = "force-dynamic";

const STONKBROKER = DEFAULT_SETTINGS.tokenAddress.toLowerCase();
const PAIRS_URL = `https://api.dexscreener.com/token-pairs/v1/robinhood/${STONKBROKER}`;
const DUST_LIQUIDITY_USD = 5_000;

/** Canonical quote assets on Robinhood Chain (lowercase). */
const TRUSTED_QUOTES = new Set([
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
  STONKBROKER, // STONK (for pairs where STONK is the quote side)
]);

type DexPair = {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  volume?: { h24?: number };
  liquidity?: { usd?: number; quote?: number };
};

export type PairRow = {
  pairAddress: string;
  dex: string;
  url: string | null;
  base: string;
  quote: string;
  priceUsd: number | null;
  liquidityUsd: number | null;
  /** USD value of the QUOTE side reserve - the unspoofable depth figure. */
  quoteDepthUsd: number | null;
  /** Quote asset is canonical WETH / USDG / STONK (or native ETH). */
  trustedQuote: boolean;
  volume24hUsd: number | null;
  dust: boolean;
};

function quoteDepthUsd(p: DexPair): number | null {
  const priceUsd = Number(p.priceUsd ?? 0);
  const priceNative = Number(p.priceNative ?? 0);
  const quoteQty = Number(p.liquidity?.quote ?? 0);
  if (!priceUsd || !priceNative || !quoteQty) return null;
  return quoteQty * (priceUsd / priceNative);
}

function isTrustedQuote(p: DexPair): boolean {
  const addr = (p.quoteToken?.address ?? "").toLowerCase();
  if (addr === "0x0000000000000000000000000000000000000000" && p.quoteToken?.symbol === "ETH")
    return true;
  return TRUSTED_QUOTES.has(addr);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function load() {
  const pairs = await getJson<DexPair[]>(PAIRS_URL, 12_000);

  const rows: PairRow[] = [];
  for (const p of pairs) {
    if (p.chainId !== "robinhood" || !p.pairAddress) continue;
    const liq = p.liquidity?.usd ?? null;
    rows.push({
      pairAddress: p.pairAddress,
      dex: p.dexId ?? "?",
      url: p.url ?? null,
      base: p.baseToken?.symbol ?? "?",
      quote: p.quoteToken?.symbol ?? "?",
      priceUsd: Number(p.priceUsd ?? 0) || null,
      liquidityUsd: liq,
      quoteDepthUsd: quoteDepthUsd(p),
      trustedQuote: isTrustedQuote(p),
      volume24hUsd: p.volume?.h24 ?? null,
      dust: (liq ?? 0) < DUST_LIQUIDITY_USD,
    });
  }
  if (rows.length === 0) throw new Error("no pairs returned");

  rows.sort((a, b) => (b.liquidityUsd ?? 0) - (a.liquidityUsd ?? 0));

  const liqs = rows.map((r) => r.liquidityUsd ?? 0);
  const summary = {
    pairCount: rows.length,
    totalLiquidityUsd: liqs.reduce((a, b) => a + b, 0),
    medianLiquidityUsd: median(liqs),
    totalVolume24hUsd: rows.reduce((a, r) => a + (r.volume24hUsd ?? 0), 0),
    trustedQuoteCount: rows.filter((r) => r.trustedQuote).length,
    dustCount: rows.filter((r) => r.dust).length,
    dustThresholdUsd: DUST_LIQUIDITY_USD,
  };

  return { ok: true, token: STONKBROKER, chain: "robinhood", summary, pairs: rows };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("pair-map", 120_000, load);
    return feedResponse({ ...data, stale, updatedAt: at }, 60);
  } catch (err) {
    return feedError(String(err));
  }
}
