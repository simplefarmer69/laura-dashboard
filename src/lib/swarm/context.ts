import type { DailyGrade, Draft, MetricsSnapshot, ResearchBrief, Settings } from "@/lib/types";

export function usd(n: number, digits = 0): string {
  if (!Number.isFinite(n)) return "n/a";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(digits || (n < 1 ? 4 : 2))}`;
}

export function pct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function metricsDigest(m: MetricsSnapshot): string {
  const rev7 = m.protocolRevenue7dUsd / 7;
  const vol7 = m.protocolVolume7dUsd / 7;
  return [
    `Data source: ${m.source}${m.warnings.length ? ` (${m.warnings.join("; ")})` : ""}`,
    `$STONKBROKER price: ${usd(m.priceUsd, 5)} (24h ${pct(m.priceChange24hPct)}), market cap ${usd(m.marketCapUsd)}, FDV ${usd(m.fdvUsd)}`,
    `Token DEX liquidity: ${usd(m.liquidityUsd)} across ${m.pairCount} pairs; token DEX volume 24h: ${usd(m.tokenDexVolume24hUsd)}`,
    `Protocol fees 24h: ${usd(m.protocolFees24hUsd)} (7d total ${usd(m.protocolFees7dUsd)})`,
    `Protocol revenue 24h: ${usd(m.protocolRevenue24hUsd)} vs 7d avg ${usd(rev7)} (${rev7 > 0 ? (m.protocolRevenue24hUsd / rev7).toFixed(2) : "n/a"}x)`,
    `Protocol volume 24h: ${usd(m.protocolVolume24hUsd)} vs 7d avg ${usd(vol7)} (${vol7 > 0 ? (m.protocolVolume24hUsd / vol7).toFixed(2) : "n/a"}x)`,
    `TVL (Robinhood Chain): ${usd(m.tvlUsd)}`,
  ].join("\n");
}

export function gradeDigest(grades: DailyGrade[]): string {
  const recent = grades.slice(-7);
  if (recent.length === 0) return "No grades recorded yet.";
  return recent
    .map(
      (g) =>
        `${g.date}: ${g.letter} ${g.score.toFixed(1)} [${g.components
          .map((c) => `${c.key} ${c.score.toFixed(0)}`)
          .join(", ")}]`,
    )
    .join("\n");
}

export function briefDigest(brief: ResearchBrief | null): string {
  if (!brief) return "No research brief this cycle.";
  return `${brief.headline}\n${brief.bullets.map((b) => `- ${b}`).join("\n")}`;
}

export function reviewerFeedback(drafts: Draft[], agentId: string, limit = 5): string {
  const reviewed = drafts
    .filter((d) => d.agentId === agentId && d.status !== "pending")
    .slice(-limit);
  if (reviewed.length === 0) return "No reviewer decisions yet for this agent.";
  return reviewed
    .map(
      (d) =>
        `- [${d.status.toUpperCase()}] "${d.title}"${d.reviewerNote ? ` - reviewer: ${d.reviewerNote}` : ""}`,
    )
    .join("\n");
}

const DOCS_CACHE: { ts: number; text: string } = { ts: 0, text: "" };

/** Plain-text excerpt of the public docs page. Cached for an hour. */
export async function fetchDocsExcerpt(settings: Settings, maxChars = 7000): Promise<string> {
  if (Date.now() - DOCS_CACHE.ts < 3_600_000 && DOCS_CACHE.text) return DOCS_CACHE.text;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(`${settings.projectSite.replace(/\/$/, "")}/docs`, {
      signal: ctrl.signal,
      headers: { "user-agent": "stonk-swarm/0.1" },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`docs HTTP ${res.status}`);
    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, (m) =>
        ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m] ?? m,
      )
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
    DOCS_CACHE.ts = Date.now();
    DOCS_CACHE.text = text;
    return text;
  } catch (err) {
    return DOCS_CACHE.text || `Docs unavailable this cycle (${String(err)}).`;
  } finally {
    clearTimeout(timer);
  }
}
