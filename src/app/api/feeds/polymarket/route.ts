import { cached, feedError, feedResponse, getJson } from "@/lib/feeds/util";

/**
 * Polymarket prediction market feed  -  the highest volume open markets from
 * the public Gamma API, trimmed to what the swarm and the console need.
 */

export const dynamic = "force-dynamic";

const URL =
  "https://gamma-api.polymarket.com/markets?closed=false&order=volume24hr&ascending=false&limit=10";

type GammaMarket = {
  question?: string;
  slug?: string;
  outcomes?: string; // JSON string array
  outcomePrices?: string; // JSON string array
  volume24hr?: number;
  endDate?: string;
};

function parseJsonArray(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

async function load() {
  const markets = await getJson<GammaMarket[]>(URL, 10_000);
  return markets
    .filter((m) => m.question)
    .map((m) => {
      const outcomes = parseJsonArray(m.outcomes);
      const prices = parseJsonArray(m.outcomePrices).map((p) => Number(p));
      return {
        question: m.question as string,
        slug: m.slug ?? "",
        url: m.slug ? `https://polymarket.com/market/${m.slug}` : null,
        outcomes: outcomes.map((label, i) => ({ label, price: prices[i] ?? null })),
        volume24hrUsd: m.volume24hr ?? null,
        endDate: m.endDate ?? null,
      };
    });
}

export async function GET() {
  try {
    const res = await cached("polymarket", 60_000, load);
    return feedResponse({ ok: true, stale: res.stale, updatedAt: res.at, markets: res.data }, 30);
  } catch (err) {
    return feedError(err instanceof Error ? err.message : "polymarket feed failed");
  }
}
