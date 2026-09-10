import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";
import { DEFAULT_SETTINGS } from "@/lib/swarm/roster";

/**
 * Token tape feed - DexScreener marks for $STONKBROKER plus the largest
 * bonded Stonklauncher tokens (tracked set from the public floor snapshot),
 * with the mandatory quote side vetting: DexScreener's headline liquidity is
 * spoofable, so a pair only counts when its QUOTE side is canonical
 * WETH / USDG / STONK (or the native ETH pseudo pair DexScreener labels
 * "ETH" on the zero address) and the quote side depth is at least $100.
 * Tokens whose top pair fails vetting are dropped, never shown with numbers
 * we cannot trust.
 *
 * Sources (public, unkeyed):
 *   https://stonkbrokers.io/api/safe-launch/floor       - tracked token set
 *   https://api.dexscreener.com/tokens/v1/robinhood/... - marks (30 addr max)
 */

export const dynamic = "force-dynamic";

const FLOOR_URL = "https://stonkbrokers.io/api/safe-launch/floor";
const DEX_BATCH = "https://api.dexscreener.com/tokens/v1/robinhood";
const STONKBROKER = DEFAULT_SETTINGS.tokenAddress.toLowerCase();
/* DexScreener batches cap at 30 addresses; many bonded launcher tokens are
 * not indexed there yet, so track a wide set and let vetting pick the real
 * ones. */
const TRACKED_LAUNCHES = 29;
const MIN_QUOTE_DEPTH_USD = 100;

/** Canonical quote assets on Robinhood Chain (lowercase). */
const TRUSTED_QUOTES = new Set([
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73", // WETH
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168", // USDG
  STONKBROKER, // STONK
]);

type FloorRow = {
  id?: number;
  name?: string;
  symbol?: string;
  phase?: string;
  live?: { token?: string; mcapUsd?: number | null } | null;
};

type DexPair = {
  chainId?: string;
  pairAddress?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceNative?: string;
  priceUsd?: string;
  volume?: { h24?: number };
  priceChange?: { h24?: number };
  liquidity?: { usd?: number; quote?: number };
};

export type TokenTapeRow = {
  address: string;
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  quoteSymbol: string;
  pinned: boolean;
};

export type TokenTapeData = {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  tracked: number;
  rows: TokenTapeRow[];
};

/** Quote side vetting: trusted quote asset + real quote side depth. */
function vetPair(p: DexPair): { ok: boolean; quoteDepthUsd: number } {
  const quoteAddr = (p.quoteToken?.address ?? "").toLowerCase();
  const isNativeEth =
    quoteAddr === "0x0000000000000000000000000000000000000000" && p.quoteToken?.symbol === "ETH";
  if (!isNativeEth && !TRUSTED_QUOTES.has(quoteAddr)) return { ok: false, quoteDepthUsd: 0 };

  const priceUsd = Number(p.priceUsd ?? 0);
  const priceNative = Number(p.priceNative ?? 0);
  const quoteQty = Number(p.liquidity?.quote ?? 0);
  if (!priceUsd || !priceNative || !quoteQty) return { ok: false, quoteDepthUsd: 0 };
  const quoteUsdEach = priceUsd / priceNative;
  const depth = quoteQty * quoteUsdEach;
  return { ok: depth >= MIN_QUOTE_DEPTH_USD, quoteDepthUsd: depth };
}

async function load(): Promise<TokenTapeData> {
  const floor = await getJson<{ rows?: FloorRow[] }>(FLOOR_URL, 12_000).catch(() => null);
  const bondedTop = (floor?.rows ?? [])
    .filter((r) => r.phase === "bonded" && r.live?.token && (r.live?.mcapUsd ?? 0) > 0)
    .sort((a, b) => (b.live?.mcapUsd ?? 0) - (a.live?.mcapUsd ?? 0));

  const addrs: string[] = [STONKBROKER];
  for (const r of bondedTop) {
    const t = (r.live?.token ?? "").toLowerCase();
    if (!t || addrs.includes(t)) continue;
    addrs.push(t);
    if (addrs.length >= 1 + TRACKED_LAUNCHES) break;
  }

  const pairs = await getJson<DexPair[]>(`${DEX_BATCH}/${addrs.join(",")}`, 12_000);

  const rows: TokenTapeRow[] = [];
  const seen = new Set<string>();
  for (const p of pairs) {
    if (p.chainId !== "robinhood") continue;
    const base = (p.baseToken?.address ?? "").toLowerCase();
    if (!base || seen.has(base) || !addrs.includes(base)) continue;
    const vet = vetPair(p);
    if (!vet.ok) continue;
    seen.add(base);
    rows.push({
      address: p.baseToken?.address ?? base,
      symbol: p.baseToken?.symbol ?? "?",
      name: p.baseToken?.name ?? "",
      priceUsd: Number(p.priceUsd ?? 0),
      change24hPct: p.priceChange?.h24 ?? null,
      volume24hUsd: p.volume?.h24 ?? null,
      liquidityUsd: p.liquidity?.usd ?? null,
      quoteSymbol: p.quoteToken?.symbol ?? "",
      pinned: base === STONKBROKER,
    });
  }

  /* STONKBROKER first, then by 24h volume. */
  rows.sort((a, b) => Number(b.pinned) - Number(a.pinned) || (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0));

  if (rows.length === 0) throw new Error("no vetted pairs returned");

  return { ok: true, updatedAt: Date.now(), stale: false, tracked: addrs.length, rows };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("token-tape", 120_000, load);
    return feedResponse({ ...data, stale, updatedAt: at }, 60);
  } catch (err) {
    return feedError(String(err));
  }
}
