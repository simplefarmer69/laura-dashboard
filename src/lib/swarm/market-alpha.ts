import { getJson } from "@/lib/feeds/util";
import type { LlamaChainsFeed, RankedProtocol } from "@/app/api/feeds/llama-chains/route";

/**
 * MARKET ALPHA: Robinhood Chain measured against all of crypto (DeFiLlama),
 * and StonkBrokers measured against every protocol on Robinhood Chain.
 * Operator directive 2026-09-13: "laura can use defillama stats for robinhood
 * chain and all of crypto to compare to robinhoodchain as well as info from
 * her apis to provide alpha".
 *
 * Output is a block of "- " lines in the same shape as CHAIN ALPHA so the
 * orchestrator can append it and the X producers' lane split distributes the
 * lines. Every line names its number and its source (defillama.com) so the
 * post built from it can be checked by a stranger. Comparative framing is
 * the point: a chain rank, a share of all DEX volume, a protocol rank on the
 * chain. Never a bare counter.
 */

const FEED_URL = `http://127.0.0.1:${process.env.PORT ?? 4747}/api/feeds/llama-chains`;
const MAX_LINES = 9;

function usd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}b`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}m`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`;
  return `$${n.toFixed(0)}`;
}

function signed(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "n/a";
  return `${p >= 0 ? "+" : ""}${p.toFixed(1)}%`;
}

function ours(list: RankedProtocol[], label: string): string | null {
  const sb = list.find((p) => /^stonkbrokers$/i.test(p.name)) ?? list.find((p) => /stonk/i.test(p.name));
  if (!sb) return null;
  const anvil = list.find((p) => /anvil/i.test(p.name));
  return `StonkBrokers ranks #${sb.rank} of ${sb.of} protocols on Robinhood Chain by ${label} (${usd(sb.usd24h)} 24h, ${usd(sb.usd7d)} 7d${anvil ? `; Clutch Anvil AMM #${anvil.rank}, ${usd(anvil.usd24h)} 24h` : ""}). Source: defillama.com/chain/Robinhood%20Chain.`;
}

export function marketAlphaLines(f: LlamaChainsFeed): string[] {
  const lines: string[] = [];
  const t = f.tvl;
  if (t.rank != null && t.usd != null) {
    const above = t.neighbours.filter((n) => n.rank < t.rank!).at(-1);
    const below = t.neighbours.find((n) => n.rank > t.rank!);
    lines.push(
      `Robinhood Chain is the #${t.rank} chain by TVL of ${t.chainsRanked} DeFiLlama tracks: ${usd(t.usd)}, ${t.shareOfAllChainsPct ?? "n/a"}% of all DeFi TVL (${usd(t.allChainsUsd)}), ${signed(t.change7dPct)} over 7d and ${signed(t.change30dPct)} over 30d${above ? `; ${above.name} above at ${usd(above.usd)}` : ""}${below ? `, ${below.name} below at ${usd(below.usd)}` : ""}. Source: defillama.com/chains.`,
    );
  }
  const d = f.dex;
  if (d.usd24h != null) {
    lines.push(
      `DEX volume on Robinhood Chain: ${usd(d.usd24h)} in 24h (${signed(d.change1dPct)} vs the day before), ${usd(d.usd7d)} over 7d (${signed(d.change7dPct)} vs the prior week)${d.shareOfAllChains24hPct != null ? `, ${d.shareOfAllChains24hPct}% of all crypto DEX volume (${usd(d.allChainsUsd24h)})` : d.shareOfAllChains7dPct != null ? `, ${d.shareOfAllChains7dPct}% of all crypto DEX volume over 7d (${usd(d.allChainsUsd7d)})` : ""}. Source: defillama.com/dexs/chain/Robinhood%20Chain.`,
    );
    if (d.topOnChain.length >= 3)
      lines.push(
        `Top DEXs on Robinhood Chain by 24h volume: ${d.topOnChain
          .slice(0, 5)
          .map((p) => `${p.name} ${usd(p.usd24h)}`)
          .join(", ")} (${d.protocolsOnChain} DEXs tracked). Source: defillama.com.`,
      );
    const o = ours(d.ours, "DEX volume");
    if (o) lines.push(o);
  }
  const fe = f.fees;
  if (fe.usd24h != null) {
    lines.push(
      `Fees paid on Robinhood Chain: ${usd(fe.usd24h)} in 24h (${signed(fe.change1dPct)}), ${usd(fe.usd7d)} over 7d (${signed(fe.change7dPct)})${fe.shareOfAllChains7dPct != null ? `, ${fe.shareOfAllChains7dPct}% of all crypto protocol fees over 7d` : ""}. Source: defillama.com/fees/chain/Robinhood%20Chain.`,
    );
    if (fe.topOnChain.length >= 3)
      lines.push(
        `Top fee earners on Robinhood Chain (24h): ${fe.topOnChain
          .slice(0, 5)
          .map((p) => `${p.name} ${usd(p.usd24h)}`)
          .join(", ")}. Source: defillama.com.`,
      );
    const o = ours(fe.ours, "fees");
    if (o) lines.push(o);
  }
  const pt = f.protocolTvl;
  if (pt.topOnChain.length >= 3) {
    lines.push(
      `Largest protocols on Robinhood Chain by TVL: ${pt.topOnChain
        .slice(0, 5)
        .map((p) => `${p.name} ${usd(p.usd)}${p.category ? ` (${p.category})` : ""}`)
        .join(", ")}; ${pt.protocolsOnChain} protocols live on the chain. Source: defillama.com.`,
    );
    const sb = pt.ours.find((p) => /^stonkbrokers$/i.test(p.name));
    if (sb) lines.push(`StonkBrokers TVL ranks #${sb.rank} of ${sb.of} protocols on Robinhood Chain at ${usd(sb.usd)}. Source: defillama.com/protocol/stonkbrokers.`);
  }
  return lines.slice(0, MAX_LINES);
}

/**
 * Lines for the CHAIN ALPHA block, each prefixed so producers see the source
 * class at a glance. Fetches the local feed (10 min cache behind it); on any
 * failure returns one line that says so rather than inventing numbers.
 */
export async function marketAlphaLinesLive(): Promise<string[]> {
  try {
    const f = await getJson<LlamaChainsFeed | { ok: false; error: string }>(FEED_URL, 25_000);
    if (!f.ok) return [`- MARKET (DeFiLlama): unavailable this cycle (${f.error}); do not invent chain comparisons.`];
    const lines = marketAlphaLines(f).map((l) => `- MARKET (DeFiLlama): ${l}`);
    if (lines.length === 0) return ["- MARKET (DeFiLlama): no usable chain rows this cycle; do not invent chain comparisons."];
    if (f.warnings.length) lines.push(`- MARKET (DeFiLlama) caveat: ${f.warnings.join("; ")}.`);
    return lines;
  } catch (err) {
    return [`- MARKET (DeFiLlama): unavailable this cycle (${String(err).slice(0, 120)}); do not invent chain comparisons.`];
  }
}

/**
 * Appends the market lines to a CHAIN ALPHA block ahead of its footer so the
 * producers' lane split (which distributes every "- " line) covers both the
 * on-chain diffs and the cross-crypto comparisons.
 */
export function mergeAlpha(chainAlpha: string, marketLines: string[]): string {
  const rows = chainAlpha.split("\n");
  const footerAt = rows.findIndex((r, i) => i > 0 && r.startsWith("("));
  const head = footerAt >= 0 ? rows.slice(0, footerAt) : rows;
  const footer = footerAt >= 0 ? rows.slice(footerAt) : [];
  head[0] = head[0].replace(
    "what changed on Robinhood Chain that most people have not noticed.",
    "what changed on Robinhood Chain that most people have not noticed, plus MARKET lines that place Robinhood Chain against all of crypto and StonkBrokers against every protocol on the chain (DeFiLlama, verifiable).",
  );
  return [...head, ...marketLines, ...footer].join("\n");
}
