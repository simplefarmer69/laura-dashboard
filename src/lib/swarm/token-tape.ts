import { getJson } from "@/lib/feeds/util";

interface TapeRow {
  symbol: string;
  name: string;
  priceUsd: number;
  change24hPct: number | null;
  volume24hUsd: number | null;
  liquidityUsd: number | null;
  quoteSymbol: string;
  pinned: boolean;
}

interface TapeFeed {
  ok: boolean;
  updatedAt: number;
  stale: boolean;
  rows: TapeRow[];
}

const usd = (n: number | null): string => (n === null ? "n/a" : `$${Math.round(n).toLocaleString()}`);

/**
 * Ticker's own feed (/api/feeds/tokens: DexScreener marks for $STONKBROKER
 * and the largest vetted launcher tokens) rendered for a prompt. Local server
 * first; a missing feed returns a note rather than throwing.
 */
export async function tokenTapeDigest(limit = 14): Promise<string> {
  try {
    const feed = await getJson<TapeFeed>(`http://127.0.0.1:${process.env.PORT ?? 4747}/api/feeds/tokens`, 20_000);
    if (!feed.rows?.length) return "Token tape empty right now.";
    const rows = [...feed.rows].sort((a, b) => (b.volume24hUsd ?? 0) - (a.volume24hUsd ?? 0)).slice(0, limit);
    const lines = rows.map(
      (r) =>
        `- $${r.symbol} (${r.name}${r.pinned ? ", mission token" : ""}) ${r.priceUsd < 0.01 ? r.priceUsd.toExponential(2) : `$${r.priceUsd.toFixed(4)}`}, ${r.change24hPct === null ? "n/a" : `${r.change24hPct >= 0 ? "+" : ""}${r.change24hPct.toFixed(1)}%`} 24h, vol ${usd(r.volume24hUsd)}, vetted liq ${usd(r.liquidityUsd)} (quote ${r.quoteSymbol})`,
    );
    return `${lines.join("\n")}\nRead ${new Date(feed.updatedAt).toISOString().slice(0, 16).replace("T", " ")} UTC${feed.stale ? " (stale)" : ""}.`;
  } catch (err) {
    return `Token tape unavailable this run (${String(err).slice(0, 80)}).`;
  }
}
