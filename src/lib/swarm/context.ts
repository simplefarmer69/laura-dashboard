import type { CycleRun, DailyGrade, Draft, MetricsSnapshot, ResearchBrief, Settings } from "@/lib/types";

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
    m.ecosystemVolume24hUsd != null
      ? `Ecosystem volume 24h (feeds StonkBrokers fees): ${usd(m.ecosystemVolume24hUsd)} = Special Projects + LAURA pairs ${usd(m.ecosystemTokensVolume24hUsd ?? 0)} + Smart LP vault share ${usd(m.smartLpAttributedVolume24hUsd ?? 0)} of ${usd(m.smartLpPoolsGrossVolume24hUsd ?? 0)} gross across ${m.smartLpPoolCount ?? 0} pools`
      : "Ecosystem volume 24h: pending first read",
    `TVL (Robinhood Chain): ${usd(m.tvlUsd)}`,
  ].join("\n");
}

/**
 * $STONKBROKER price/liquidity trend computed from stored metric snapshots.
 * Reads only — no trading. The grader's 7d price baseline needs ~5.5 days of
 * history; until it lands this digest is the only longitudinal price view the
 * agents get, so strategy work on the weakest lever isn't flying blind on a
 * single 24h number.
 */
export function priceTrendDigest(history: MetricsSnapshot[], current: MetricsSnapshot): string {
  const HOUR = 3_600_000;
  const past = history.filter((s) => s.ts < current.ts && s.priceUsd > 0);
  if (past.length === 0) return "Price trend: no stored history yet (first snapshots landing this cycle).";
  const nearest = (hoursAgo: number): MetricsSnapshot | null => {
    const target = current.ts - hoursAgo * HOUR;
    let best: MetricsSnapshot | null = null;
    for (const s of past) {
      if (!best || Math.abs(s.ts - target) < Math.abs(best.ts - target)) best = s;
    }
    /* Only report a window when a snapshot lands within half of it. */
    return best && Math.abs(best.ts - target) <= 0.5 * hoursAgo * HOUR ? best : null;
  };
  const windows: string[] = [];
  for (const h of [6, 24, 72, 168]) {
    const s = nearest(h);
    if (!s) continue;
    const dPrice = ((current.priceUsd - s.priceUsd) / s.priceUsd) * 100;
    const dLiq =
      s.liquidityUsd > 0 ? ((current.liquidityUsd - s.liquidityUsd) / s.liquidityUsd) * 100 : null;
    const label = h >= 24 ? `${h / 24}d` : `${h}h`;
    windows.push(`${label}: price ${pct(dPrice)}${dLiq !== null ? `, liquidity ${pct(dLiq)}` : ""}`);
  }
  const oldest = past.reduce((min, s) => Math.min(min, s.ts), current.ts);
  const depthH = (current.ts - oldest) / HOUR;
  const depth = depthH >= 48 ? `${(depthH / 24).toFixed(1)}d` : `${depthH.toFixed(0)}h`;
  const baselineNote =
    depthH < 5.5 * 24
      ? ` The grader's 7d price baseline needs ~5.5d of history (${Math.max(0, 5.5 * 24 - depthH).toFixed(0)}h to go); until then the price score reflects the 24h move only.`
      : "";
  return `Price trend from stored snapshots (history depth ${depth}): ${windows.length ? windows.join("; ") : "windows still filling"}.${baselineNote}`;
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

/**
 * The agent's own recent output, injected so it can differ from itself.
 * Stateless prompting re-derives the same "best" answer every cycle; showing
 * the agent what it already made is the cheapest anti-repetition lever.
 */
export function recentOutputDigest(drafts: Draft[], agentId: string, limit = 5): string {
  const recent = drafts.filter((d) => d.agentId === agentId).slice(-limit);
  if (recent.length === 0) return "You have produced nothing yet — everything is a fresh angle.";
  return recent
    .map((d) => `- [${new Date(d.createdAt).toISOString().slice(0, 10)}] "${d.title}" (${d.kind}) — ${d.body.slice(0, 160).replace(/\s+/g, " ")}...`)
    .join("\n");
}

/**
 * What the REST of the swarm covered recently, injected so agents differentiate
 * from each other, not just from themselves. Cross-agent repetition is the
 * critic's top veto reason; vetoed titles are included so the same angle is
 * not re-attempted by the next agent.
 */
/**
 * Deterministic per-agent, per-cycle lane assignment — context partitioning
 * against diversity collapse. Research on multi-agent LLM systems (2026:
 * "Algorithmic Groupthink", "Diversity Collapse in Multi-Agent LLM Systems")
 * shows producers sharing one identical context converge on the same hook;
 * heterogeneous role/format assignments create independent reasoning paths.
 * Wheel lengths are co-prime (8 x 7 = 56 combos) so pairings don't cycle fast;
 * the agent-id hash offsets agents so no two share a lane within a cycle.
 */
const LANE_FORMATS = [
  "explainer thread",
  "single-number data read (one metric, fully unpacked)",
  "story or scenario piece (narrative, not bullets)",
  "step-by-step how-to walkthrough",
  "contrarian or myth-busting take",
  "Q&A / interview format",
  "comparison piece (this vs that, with a verdict)",
  "field report (what actually happened on chain today, first person)",
] as const;

const LANE_AUDIENCES = [
  "current $STONKBROKER holders",
  "meme-stock retail (GME/AMC lineage, apes culture)",
  "NFT collectors new to Robinhood Chain",
  "builders and integrators",
  "CEX listing decision-makers and market-structure people",
  "crypto X commentators looking for a story",
  "Robinhood app users curious about the chain",
] as const;

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export function laneAssignment(agentId: string, cycleSeq: number): string {
  const seed = hashId(agentId) + cycleSeq;
  const format = LANE_FORMATS[seed % LANE_FORMATS.length];
  const audience = LANE_AUDIENCES[seed % LANE_AUDIENCES.length];
  return `format: ${format} · primary audience: ${audience}`;
}

export function swarmCoverageDigest(drafts: Draft[], excludeAgentId: string, limit = 15): string {
  const recent = drafts.filter((d) => d.agentId !== excludeAgentId).slice(-limit);
  if (recent.length === 0) return "No other-agent output yet.";
  return recent
    .map((d) => {
      const veto = d.status === "rejected" ? " [VETOED as repetition — do not retry this angle]" : "";
      return `- ${d.agentId}: "${d.title}" (${d.kind})${veto}`;
    })
    .join("\n");
}

/** Operational health of recent cycles: duration, output, LLM failures. For the coach. */
export function runsDigest(runs: CycleRun[], limit = 6): string {
  const recent = runs.filter((r) => r.finishedAt).slice(-limit);
  if (recent.length === 0) return "No completed cycles yet.";
  return recent
    .map((r) => {
      const secs = ((r.finishedAt! - r.startedAt) / 1000).toFixed(0);
      const errors = r.steps.filter((s) => s.status === "error").length;
      const skipped = r.steps.filter((s) => s.status === "skipped").length;
      const llm =
        r.llmCalls != null
          ? `; LLM ${r.llmCalls} calls, ${r.llmFallbacks ?? 0} fallbacks, ${r.llmRepairs ?? 0} repairs`
          : "";
      return `- ${r.id} (${r.trigger}): ${secs}s, ${r.draftsCreated} drafts, ${r.proposalsCreated} proposals, ${errors} error step(s), ${skipped} skipped${llm}${r.error ? `; CYCLE ERROR: ${r.error}` : ""}`;
    })
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
