import type { MetricsSnapshot, OnchainReads, Settings } from "@/lib/types";
import { fetchOnchain } from "@/lib/grader/onchain";
import { fetchEcosystemVolume, type EcosystemVolume } from "@/lib/grader/ecosystem";

const TIMEOUT_MS = 15_000;

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

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  priceNative?: string;
  priceChange?: { h24?: number };
  volume?: { h24?: number };
  liquidity?: { usd?: number };
  marketCap?: number;
  fdv?: number;
}

export interface TokenMarket {
  priceUsd: number;
  priceChange24hPct: number;
  volume24hUsd: number;
  liquidityUsd: number;
  marketCapUsd: number;
  fdvUsd: number;
  pairCount: number;
  /** Derived from the deepest ETH-quoted pair (priceUsd / priceNative) */
  ethPriceUsd: number;
}

/**
 * Aggregates every pair where the token is the base asset. Price and 24h change
 * are liquidity-weighted so thin pools cannot skew the reading.
 */
export async function fetchTokenMarket(settings: Settings): Promise<TokenMarket> {
  const url = `https://api.dexscreener.com/token-pairs/v1/${settings.chainSlug}/${settings.tokenAddress}`;
  const pairs = await getJson<DexPair[]>(url);
  const token = settings.tokenAddress.toLowerCase();
  const basePairs = pairs.filter(
    (p) => p.baseToken.address.toLowerCase() === token && Number(p.priceUsd) > 0,
  );
  if (basePairs.length === 0) throw new Error("DexScreener returned no priced pairs");

  let liqSum = 0;
  let priceWeighted = 0;
  let changeWeighted = 0;
  let volume = 0;
  for (const p of basePairs) {
    const liq = p.liquidity?.usd ?? 0;
    const w = Math.max(liq, 1);
    liqSum += liq;
    priceWeighted += Number(p.priceUsd) * w;
    changeWeighted += (p.priceChange?.h24 ?? 0) * w;
    volume += p.volume?.h24 ?? 0;
  }
  // Thin pairs can print absurd caps; trust the deepest pool for cap and FDV.
  const deepest = [...basePairs].sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const marketCap = deepest.marketCap ?? 0;
  const fdv = deepest.fdv ?? 0;
  const wSum = basePairs.reduce((s, p) => s + Math.max(p.liquidity?.usd ?? 0, 1), 0);
  const ethPair = basePairs
    .filter((p) => /^W?ETH$/i.test(p.quoteToken.symbol) && Number(p.priceNative) > 0)
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
  const ethPriceUsd = ethPair ? Number(ethPair.priceUsd) / Number(ethPair.priceNative) : 0;
  return {
    priceUsd: priceWeighted / wSum,
    priceChange24hPct: changeWeighted / wSum,
    volume24hUsd: volume,
    liquidityUsd: liqSum,
    marketCapUsd: marketCap,
    fdvUsd: fdv,
    pairCount: basePairs.length,
    ethPriceUsd,
  };
}

interface LlamaSummary {
  total24h?: number | null;
  total7d?: number | null;
  total30d?: number | null;
  totalAllTime?: number | null;
  totalDataChart?: [number, number][];
}

const DAY_S = 86_400;

/**
 * DeFiLlama's total24h is the CURRENT UTC DAY so far, not a rolling day: it
 * reads ~$0 right after midnight and only fills in by evening, which is why
 * the console showed "$0 protocol volume" some mornings. Estimate a rolling
 * 24h instead: today's partial bucket plus yesterday's bucket scaled by the
 * part of today that has not elapsed. Falls back to total24h when the chart
 * is missing.
 */
export function rolling24h(summary: LlamaSummary, nowMs = Date.now()): number {
  const chart = summary.totalDataChart ?? [];
  if (chart.length === 0) return summary.total24h ?? 0;
  const nowS = Math.floor(nowMs / 1000);
  const todayStart = nowS - (nowS % DAY_S);
  const fractionElapsed = Math.min(1, Math.max(0, (nowS - todayStart) / DAY_S));
  const byDay = new Map(chart.map(([ts, v]) => [ts, v ?? 0]));
  const today = byDay.get(todayStart) ?? summary.total24h ?? 0;
  const yesterday = byDay.get(todayStart - DAY_S) ?? 0;
  return today + yesterday * (1 - fractionElapsed);
}

interface LlamaProtocol {
  currentChainTvls?: Record<string, number>;
}

export interface ProtocolMetrics {
  fees24h: number;
  revenue24h: number;
  volume24h: number;
  fees7d: number;
  revenue7d: number;
  volume7d: number;
  tvl: number;
}

export async function fetchProtocolMetrics(settings: Settings): Promise<ProtocolMetrics> {
  const slug = settings.llamaSlug;
  const [fees, revenue, volume, protocol] = await Promise.all([
    getJson<LlamaSummary>(`https://api.llama.fi/summary/fees/${slug}?dataType=dailyFees`),
    getJson<LlamaSummary>(`https://api.llama.fi/summary/fees/${slug}?dataType=dailyRevenue`),
    getJson<LlamaSummary>(`https://api.llama.fi/summary/dexs/${slug}?dataType=dailyVolume`),
    getJson<LlamaProtocol>(`https://api.llama.fi/protocol/${slug}`),
  ]);
  const chainTvl = Object.entries(protocol.currentChainTvls ?? {})
    .filter(([k]) => !k.includes("-") && k !== "staking" && k !== "borrowed" && k !== "pool2")
    .reduce((s, [, v]) => s + v, 0);
  return {
    fees24h: rolling24h(fees),
    revenue24h: rolling24h(revenue),
    volume24h: rolling24h(volume),
    fees7d: fees.total7d ?? 0,
    revenue7d: revenue.total7d ?? 0,
    volume7d: volume.total7d ?? 0,
    tvl: chainTvl,
  };
}

/** Fallback used when both upstreams are unreachable so the loop keeps running. */
export function mockMetrics(prev?: MetricsSnapshot | null): MetricsSnapshot {
  const base = prev ?? {
    priceUsd: 0.011,
    tokenDexVolume24hUsd: 1_500_000,
    liquidityUsd: 5_000_000,
    marketCapUsd: 17_000_000,
    fdvUsd: 26_000_000,
    protocolFees24hUsd: 15_000,
    protocolRevenue24hUsd: 9_000,
    protocolVolume24hUsd: 100_000,
    protocolFees7dUsd: 95_000,
    protocolRevenue7dUsd: 45_000,
    protocolVolume7dUsd: 550_000,
    tvlUsd: 1_400_000,
  };
  const jitter = () => 1 + (Math.random() - 0.5) * 0.1;
  return {
    ts: Date.now(),
    priceUsd: base.priceUsd * jitter(),
    priceChange24hPct: (Math.random() - 0.5) * 10,
    tokenDexVolume24hUsd: base.tokenDexVolume24hUsd * jitter(),
    liquidityUsd: base.liquidityUsd * jitter(),
    marketCapUsd: base.marketCapUsd * jitter(),
    fdvUsd: base.fdvUsd * jitter(),
    pairCount: 30,
    protocolFees24hUsd: base.protocolFees24hUsd * jitter(),
    protocolRevenue24hUsd: base.protocolRevenue24hUsd * jitter(),
    protocolVolume24hUsd: base.protocolVolume24hUsd * jitter(),
    protocolFees7dUsd: base.protocolFees7dUsd,
    protocolRevenue7dUsd: base.protocolRevenue7dUsd,
    protocolVolume7dUsd: base.protocolVolume7dUsd,
    tvlUsd: base.tvlUsd * jitter(),
    source: "mock",
    warnings: ["Upstream data unavailable; synthetic metrics in use."],
  };
}

export async function collectMetrics(
  settings: Settings,
  prev?: MetricsSnapshot | null,
): Promise<MetricsSnapshot> {
  const [market, protocol] = await Promise.allSettled([
    fetchTokenMarket(settings),
    fetchProtocolMetrics(settings),
  ]);
  const warnings: string[] = [];
  if (market.status === "rejected") warnings.push(`DexScreener: ${String(market.reason)}`);
  if (protocol.status === "rejected") warnings.push(`DefiLlama: ${String(protocol.reason)}`);
  if (market.status === "rejected" && protocol.status === "rejected") {
    return mockMetrics(prev);
  }
  const m = market.status === "fulfilled" ? market.value : null;
  const p = protocol.status === "fulfilled" ? protocol.value : null;
  const ethUsd = m?.ethPriceUsd ?? prev?.onchain?.ethPriceUsd ?? 0;
  let onchain: OnchainReads | undefined;
  let eco: EcosystemVolume | null = null;
  const [onchainRes, ecoRes] = await Promise.allSettled([
    fetchOnchain(settings, ethUsd),
    fetchEcosystemVolume(settings.chainSlug, settings.tokenAddress, ethUsd, m?.volume24hUsd ?? prev?.tokenDexVolume24hUsd ?? 0),
  ]);
  if (onchainRes.status === "fulfilled") {
    onchain = onchainRes.value;
  } else {
    warnings.push(`RPC: ${String(onchainRes.reason)}`);
    onchain = prev?.onchain;
  }
  if (ecoRes.status === "fulfilled") {
    eco = ecoRes.value;
    for (const w of eco.warnings) warnings.push(`Ecosystem volume: ${w}`);
  } else {
    warnings.push(`Ecosystem volume: ${String(ecoRes.reason)}`);
  }
  return {
    ts: Date.now(),
    priceUsd: m?.priceUsd ?? prev?.priceUsd ?? 0,
    priceChange24hPct: m?.priceChange24hPct ?? 0,
    tokenDexVolume24hUsd: m?.volume24hUsd ?? prev?.tokenDexVolume24hUsd ?? 0,
    liquidityUsd: m?.liquidityUsd ?? prev?.liquidityUsd ?? 0,
    marketCapUsd: m?.marketCapUsd ?? prev?.marketCapUsd ?? 0,
    fdvUsd: m?.fdvUsd ?? prev?.fdvUsd ?? 0,
    pairCount: m?.pairCount ?? prev?.pairCount ?? 0,
    protocolFees24hUsd: p?.fees24h ?? prev?.protocolFees24hUsd ?? 0,
    protocolRevenue24hUsd: p?.revenue24h ?? prev?.protocolRevenue24hUsd ?? 0,
    protocolVolume24hUsd: p?.volume24h ?? prev?.protocolVolume24hUsd ?? 0,
    protocolFees7dUsd: p?.fees7d ?? prev?.protocolFees7dUsd ?? 0,
    protocolRevenue7dUsd: p?.revenue7d ?? prev?.protocolRevenue7dUsd ?? 0,
    protocolVolume7dUsd: p?.volume7d ?? prev?.protocolVolume7dUsd ?? 0,
    tvlUsd: p?.tvl ?? prev?.tvlUsd ?? 0,
    ecosystemVolume24hUsd: eco?.totalUsd ?? prev?.ecosystemVolume24hUsd,
    ecosystemVolumeVersion: eco ? 2 : prev?.ecosystemVolumeVersion,
    ecosystemTokensVolume24hUsd: eco?.ecosystemTokensUsd ?? prev?.ecosystemTokensVolume24hUsd,
    specialProjectsVolume24hUsd: eco?.specialProjectsUsd ?? prev?.specialProjectsVolume24hUsd,
    launcherTokensVolume24hUsd: eco?.launcherTokensUsd ?? prev?.launcherTokensVolume24hUsd,
    launcherTokenCount: eco?.launcherTokenCount ?? prev?.launcherTokenCount,
    smartLpAttributedVolume24hUsd: eco?.smartLpAttributedUsd ?? prev?.smartLpAttributedVolume24hUsd,
    smartLpPoolsGrossVolume24hUsd: eco?.smartLpPoolsGrossUsd ?? prev?.smartLpPoolsGrossVolume24hUsd,
    ecosystemPairCount: eco?.pairCount ?? prev?.ecosystemPairCount,
    smartLpPoolCount: eco?.smartLpPoolCount ?? prev?.smartLpPoolCount,
    onchain,
    source: market.status === "rejected" || protocol.status === "rejected" ? "partial" : "live",
    warnings,
  };
}
