import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * Chain comparison feed - Robinhood Chain against all of crypto, from
 * DeFiLlama's chain-level endpoints, plus where StonkBrokers ranks among the
 * protocols ON Robinhood Chain. This is the raw material for comparative
 * alpha ("Robinhood Chain is the #10 chain by TVL and did 20% of all DEX
 * volume yesterday"): every number here is public and verifiable on
 * defillama.com, so a post built on it survives a fact check.
 *
 * Sources (public, unkeyed):
 *   /v2/chains                                   - TVL per chain (rank, share)
 *   /v2/historicalChainTvl/Robinhood%20Chain     - chain TVL history (7d/30d change)
 *   /overview/dexs/Robinhood%20Chain             - DEX volume on the chain, per protocol
 *   /overview/dexs                               - DEX volume, all chains
 *   /overview/fees/Robinhood%20Chain             - fees on the chain, per protocol
 *   /overview/fees                               - fees, all chains
 *   /protocols                                   - protocol TVL on the chain
 *
 * Sanity: DeFiLlama's all-chains fee total is occasionally polluted by one
 * protocol's bad day (a 28,000% 1d change was observed 2026-09-13). When the
 * 24h total is more than 5x the 7d daily average the share is reported null
 * with a warning instead of a fake percentage.
 */

export const dynamic = "force-dynamic";

const API = "https://api.llama.fi";
const CHAIN = "Robinhood Chain";
const CHAIN_PATH = encodeURIComponent(CHAIN);
const TOP_CHAINS = 12;
const TOP_PROTOCOLS = 8;
const OURS = /stonk|clutch|anvil/i;

type ChainRow = { name: string; tvl: number; chainId?: number | null };
type HistoryPoint = { date: number; tvl: number };
type OverviewProtocol = {
  name: string;
  slug?: string;
  category?: string;
  total24h?: number | null;
  total7d?: number | null;
  change_1d?: number | null;
  chains?: string[];
};
type Overview = {
  total24h?: number | null;
  total7d?: number | null;
  change_1d?: number | null;
  change_7dover7d?: number | null;
  protocols?: OverviewProtocol[];
};
type ProtocolRow = { name: string; slug?: string; category?: string; chains?: string[]; chainTvls?: Record<string, number> };

export interface RankedProtocol {
  rank: number;
  of: number;
  name: string;
  category: string | null;
  usd24h: number | null;
  usd7d: number | null;
}

export interface LlamaChainsFeed {
  ok: true;
  updatedAt: number;
  stale: boolean;
  chain: string;
  warnings: string[];
  tvl: {
    usd: number | null;
    rank: number | null;
    chainsRanked: number;
    shareOfAllChainsPct: number | null;
    allChainsUsd: number | null;
    change7dPct: number | null;
    change30dPct: number | null;
    topChains: { rank: number; name: string; usd: number }[];
    /** Chains just above and below Robinhood Chain in the TVL table */
    neighbours: { rank: number; name: string; usd: number }[];
  };
  dex: {
    usd24h: number | null;
    usd7d: number | null;
    change1dPct: number | null;
    change7dPct: number | null;
    allChainsUsd24h: number | null;
    allChainsUsd7d: number | null;
    shareOfAllChains24hPct: number | null;
    shareOfAllChains7dPct: number | null;
    protocolsOnChain: number;
    topOnChain: RankedProtocol[];
    ours: RankedProtocol[];
  };
  fees: {
    usd24h: number | null;
    usd7d: number | null;
    change1dPct: number | null;
    change7dPct: number | null;
    allChainsUsd24h: number | null;
    allChainsUsd7d: number | null;
    shareOfAllChains24hPct: number | null;
    shareOfAllChains7dPct: number | null;
    protocolsOnChain: number;
    topOnChain: RankedProtocol[];
    ours: RankedProtocol[];
  };
  protocolTvl: {
    protocolsOnChain: number;
    topOnChain: { rank: number; name: string; category: string | null; usd: number }[];
    ours: { rank: number; of: number; name: string; category: string | null; usd: number }[];
  };
}

function pct(part: number | null | undefined, whole: number | null | undefined): number | null {
  if (part == null || whole == null || whole <= 0) return null;
  return Math.round((part / whole) * 10_000) / 100;
}

function changePct(now: number | undefined, then: number | undefined): number | null {
  if (now == null || then == null || then <= 0) return null;
  return Math.round(((now - then) / then) * 1000) / 10;
}

function rank(list: OverviewProtocol[]): RankedProtocol[] {
  const sorted = [...list].sort((a, b) => (b.total24h ?? 0) - (a.total24h ?? 0));
  return sorted.map((p, i) => ({
    rank: i + 1,
    of: sorted.length,
    name: p.name,
    category: p.category ?? null,
    usd24h: p.total24h ?? null,
    usd7d: p.total7d ?? null,
  }));
}

/** DeFiLlama's aggregate 24h sometimes carries one protocol's glitch; refuse a share built on it. */
function saneTotal(total24h: number | null | undefined, total7d: number | null | undefined, label: string, warnings: string[]): number | null {
  if (total24h == null) return null;
  if (total7d != null && total7d > 0 && total24h > (total7d / 7) * 5) {
    warnings.push(`${label}: all-chains 24h total (${Math.round(total24h).toLocaleString()}) is over 5x the 7d daily average; share left null`);
    return null;
  }
  return total24h;
}

async function load(): Promise<LlamaChainsFeed> {
  const q = "?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true";
  const [chains, history, dexChain, dexAll, feesChain, feesAll, protocols] = await Promise.all([
    getJson<ChainRow[]>(`${API}/v2/chains`, 15_000),
    getJson<HistoryPoint[]>(`${API}/v2/historicalChainTvl/${CHAIN_PATH}`, 15_000),
    getJson<Overview>(`${API}/overview/dexs/${CHAIN_PATH}${q}`, 15_000),
    getJson<Overview>(`${API}/overview/dexs${q}`, 20_000),
    getJson<Overview>(`${API}/overview/fees/${CHAIN_PATH}${q}`, 15_000),
    getJson<Overview>(`${API}/overview/fees${q}`, 20_000),
    getJson<ProtocolRow[]>(`${API}/protocols`, 20_000),
  ]);
  const warnings: string[] = [];

  const ranked = [...chains].filter((c) => Number.isFinite(c.tvl)).sort((a, b) => b.tvl - a.tvl);
  const idx = ranked.findIndex((c) => c.name === CHAIN);
  const allTvl = ranked.reduce((s, c) => s + c.tvl, 0);
  const row = (i: number) => ({ rank: i + 1, name: ranked[i].name, usd: Math.round(ranked[i].tvl) });
  const neighbours = idx >= 0 ? [idx - 2, idx - 1, idx + 1, idx + 2].filter((i) => i >= 0 && i < ranked.length && i !== idx).map(row) : [];
  const hist = [...history].sort((a, b) => a.date - b.date);
  const last = hist.at(-1)?.tvl;

  const dexOnChain = (dexChain.protocols ?? []).filter((p) => (p.total24h ?? 0) > 0 || (p.total7d ?? 0) > 0);
  const feesOnChain = (feesChain.protocols ?? []).filter((p) => (p.total24h ?? 0) > 0 || (p.total7d ?? 0) > 0);
  const dexRanked = rank(dexOnChain);
  const feesRanked = rank(feesOnChain);
  const dexAll24h = saneTotal(dexAll.total24h, dexAll.total7d, "dex", warnings);
  const feesAll24h = saneTotal(feesAll.total24h, feesAll.total7d, "fees", warnings);

  const onChain = protocols
    .filter((p) => (p.chainTvls?.[CHAIN] ?? 0) > 0)
    .map((p) => ({ name: p.name, category: p.category ?? null, usd: Math.round(p.chainTvls?.[CHAIN] ?? 0) }))
    .sort((a, b) => b.usd - a.usd);

  return {
    ok: true,
    updatedAt: Date.now(),
    stale: false,
    chain: CHAIN,
    warnings,
    tvl: {
      usd: idx >= 0 ? Math.round(ranked[idx].tvl) : null,
      rank: idx >= 0 ? idx + 1 : null,
      chainsRanked: ranked.length,
      shareOfAllChainsPct: idx >= 0 ? pct(ranked[idx].tvl, allTvl) : null,
      allChainsUsd: Math.round(allTvl),
      change7dPct: changePct(last, hist.at(-8)?.tvl),
      change30dPct: changePct(last, hist.at(-31)?.tvl),
      topChains: ranked.slice(0, TOP_CHAINS).map((_, i) => row(i)),
      neighbours,
    },
    dex: {
      usd24h: dexChain.total24h ?? null,
      usd7d: dexChain.total7d ?? null,
      change1dPct: dexChain.change_1d ?? null,
      change7dPct: dexChain.change_7dover7d ?? null,
      allChainsUsd24h: dexAll.total24h ?? null,
      allChainsUsd7d: dexAll.total7d ?? null,
      shareOfAllChains24hPct: pct(dexChain.total24h, dexAll24h),
      shareOfAllChains7dPct: pct(dexChain.total7d, dexAll.total7d),
      protocolsOnChain: dexRanked.length,
      topOnChain: dexRanked.slice(0, TOP_PROTOCOLS),
      ours: dexRanked.filter((p) => OURS.test(p.name)),
    },
    fees: {
      usd24h: feesChain.total24h ?? null,
      usd7d: feesChain.total7d ?? null,
      change1dPct: feesChain.change_1d ?? null,
      change7dPct: feesChain.change_7dover7d ?? null,
      allChainsUsd24h: feesAll.total24h ?? null,
      allChainsUsd7d: feesAll.total7d ?? null,
      shareOfAllChains24hPct: pct(feesChain.total24h, feesAll24h),
      shareOfAllChains7dPct: pct(feesChain.total7d, feesAll.total7d),
      protocolsOnChain: feesRanked.length,
      topOnChain: feesRanked.slice(0, TOP_PROTOCOLS),
      ours: feesRanked.filter((p) => OURS.test(p.name)),
    },
    protocolTvl: {
      protocolsOnChain: onChain.length,
      topOnChain: onChain.slice(0, TOP_PROTOCOLS).map((p, i) => ({ rank: i + 1, ...p })),
      ours: onChain.map((p, i) => ({ rank: i + 1, of: onChain.length, ...p })).filter((p) => OURS.test(p.name)),
    },
  };
}

export async function GET() {
  try {
    const { data, stale, at } = await cached("feed:llama-chains", 10 * 60_000, load);
    return feedResponse({ ...data, stale, updatedAt: at }, 300);
  } catch (err) {
    return feedError(`llama-chains: ${err instanceof Error ? err.message : String(err)}`);
  }
}
