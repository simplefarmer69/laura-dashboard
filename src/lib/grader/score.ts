import type {
  DailyGrade,
  GradeComponent,
  LetterGrade,
  MetricsSnapshot,
  SwarmState,
} from "@/lib/types";
import { newId } from "@/lib/store";

const DAY_MS = 86_400_000;

/** Fallback cycle length until enough finished runs exist to measure one. */
const ASSUMED_CYCLE_MINUTES = 25;

/**
 * Cycles the swarm can realistically land in a day. `cycleIntervalMinutes` is
 * the rest gap between cycles (continuous operation), so the period is that
 * gap plus the median observed cycle duration — dividing 1440 by a 2-minute
 * gap alone would set a 720-cycle target no swarm could meet.
 */
export function expectedCyclesPerDay(state: SwarmState): number {
  const durations = state.runs
    .filter((r) => r.finishedAt && !r.error)
    .slice(-12)
    .map((r) => ((r.finishedAt as number) - r.startedAt) / 60_000)
    .sort((a, b) => a - b);
  const median = durations.length >= 3 ? durations[Math.floor(durations.length / 2)] : ASSUMED_CYCLE_MINUTES;
  const periodMinutes = Math.max(1, state.settings.cycleIntervalMinutes) + median;
  return Math.max(1, Math.min(state.settings.maxLlmCyclesPerDay, Math.floor(1440 / periodMinutes)));
}

export const WEIGHTS = { price: 0.35, revenue: 0.3, volume: 0.2, execution: 0.15 } as const;

function clamp(n: number, lo = 0, hi = 100): number {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * Maps a growth ratio to 0..100 on a log scale so gains and losses are symmetric.
 * ratio 1.0 -> 50. With sensitivity 250 a +22% move saturates at 100.
 */
export function ratioScore(ratio: number, sensitivity: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 50;
  return clamp(50 + sensitivity * Math.log(ratio));
}

export function letterFor(score: number): LetterGrade {
  if (score >= 90) return "A+";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  if (score >= 50) return "D";
  return "F";
}

export function utcDate(ts = Date.now()): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`;
  return `$${n.toFixed(2)}`;
}

/** Nearest snapshot to seven days before `now`, if the history is deep enough. */
export function findBaseline(
  history: MetricsSnapshot[],
  now: number,
): MetricsSnapshot | null {
  const target = now - 7 * DAY_MS;
  let best: MetricsSnapshot | null = null;
  for (const s of history) {
    if (Math.abs(s.ts - target) <= 1.5 * DAY_MS) {
      if (!best || Math.abs(s.ts - target) < Math.abs(best.ts - target)) best = s;
    }
  }
  return best;
}

export function scorePrice(m: MetricsSnapshot, baseline: MetricsSnapshot | null): GradeComponent {
  const r24 = 1 + m.priceChange24hPct / 100;
  const s24 = ratioScore(r24, 250);
  let score = s24;
  let detail = `24h ${fmtPct(m.priceChange24hPct)} (liquidity-weighted across ${m.pairCount} pairs)`;
  if (baseline && baseline.priceUsd > 0) {
    const r7 = m.priceUsd / baseline.priceUsd;
    const s7 = ratioScore(r7, 150);
    score = 0.6 * s24 + 0.4 * s7;
    detail += `; 7d ${fmtPct((r7 - 1) * 100)}`;
  } else {
    detail += "; 7d baseline not yet available";
  }
  return { key: "price", label: "Token price", weight: WEIGHTS.price, score, detail };
}

export function scoreRevenue(m: MetricsSnapshot): GradeComponent {
  const avg7 = m.protocolRevenue7dUsd / 7;
  const ratio = avg7 > 0 ? m.protocolRevenue24hUsd / avg7 : 1;
  const score = ratioScore(ratio, 100);
  const detail = `24h revenue ${fmtUsd(m.protocolRevenue24hUsd)} vs 7d avg ${fmtUsd(avg7)} (${ratio.toFixed(2)}x); fees ${fmtUsd(m.protocolFees24hUsd)}`;
  return { key: "revenue", label: "Protocol revenue", weight: WEIGHTS.revenue, score, detail };
}

/**
 * The "tape" the grade watches: $STONKBROKER DEX volume plus the ecosystem
 * volume (Special Projects + LAURA pairs in full, other Smart LP pools by the
 * vaults' share of pool liquidity). Both feed StonkBrokers fees, so a snapshot
 * that predates the ecosystem metric only counts the token leg.
 */
export function tapeVolume(m: MetricsSnapshot): number {
  return m.tokenDexVolume24hUsd + (m.ecosystemVolume24hUsd ?? 0);
}

export function scoreVolume(m: MetricsSnapshot, history: MetricsSnapshot[]): GradeComponent {
  const avg7 = m.protocolVolume7dUsd / 7;
  const protoRatio = avg7 > 0 ? m.protocolVolume24hUsd / avg7 : 1;
  const protoScore = ratioScore(protoRatio, 100);

  const weekAgo = m.ts - 7 * DAY_MS;
  // Trailing window compares like with like: once the ecosystem metric exists
  // on the current snapshot, only history that also carries it is averaged so
  // the first days after rollout cannot read as a fake volume spike.
  const hasEco = m.ecosystemVolume24hUsd != null;
  const window = history.filter(
    (s) =>
      s.ts >= weekAgo &&
      s.ts < m.ts &&
      s.tokenDexVolume24hUsd > 0 &&
      (!hasEco || s.ecosystemVolume24hUsd != null),
  );
  const tape = tapeVolume(m);
  const tapeLabel = hasEco
    ? `token DEX ${fmtUsd(m.tokenDexVolume24hUsd)} + ecosystem ${fmtUsd(m.ecosystemVolume24hUsd ?? 0)} = ${fmtUsd(tape)}`
    : `token DEX volume ${fmtUsd(m.tokenDexVolume24hUsd)}`;
  let detail = `protocol surfaces ${fmtUsd(m.protocolVolume24hUsd)} vs 7d avg ${fmtUsd(avg7)} (${protoRatio.toFixed(2)}x)`;
  // The fee-bearing tape is the bigger signal: protocol-surface volume is a
  // small slice of what actually pays StonkBrokers once Smart LP is counted.
  // Without a trailing window the tape leg reads neutral (50) instead of
  // letting the DefiLlama slice alone pin the whole component at zero.
  let tapeScore = 50;
  if (window.length >= 4) {
    const tapeAvg = window.reduce((s, x) => s + tapeVolume(x), 0) / window.length;
    const tapeRatio = tapeAvg > 0 ? tape / tapeAvg : 1;
    tapeScore = ratioScore(tapeRatio, 100);
    detail += `; ${tapeLabel} (${tapeRatio.toFixed(2)}x trailing)`;
  } else {
    detail += `; ${tapeLabel} (trailing avg pending)`;
  }
  const score = 0.4 * protoScore + 0.6 * tapeScore;
  return { key: "volume", label: "Protocol & token volume", weight: WEIGHTS.volume, score, detail };
}

export function scoreExecution(state: SwarmState, now: number): GradeComponent {
  const since = now - DAY_MS;
  const recent = state.drafts.filter((d) => d.createdAt >= since);
  const reviewed = recent.filter((d) => d.status !== "pending");
  const approved = reviewed.filter((d) => d.status === "approved" || d.status === "published");
  const cyclesPerDay = expectedCyclesPerDay(state);
  const target = state.settings.maxDraftsPerCycle * cyclesPerDay * 0.5;
  const proposals = state.proposals.filter((p) => p.createdAt >= since);
  const adopted = proposals.filter((p) => p.status === "approved");

  if (reviewed.length === 0) {
    return {
      key: "execution",
      label: "Swarm execution",
      weight: WEIGHTS.execution,
      score: 50,
      detail: `No reviewer decisions in the last 24h (${recent.length} drafts pending); neutral until reviewers act`,
    };
  }
  const approvalRate = approved.length / reviewed.length;
  const throughput = clamp((approved.length / target) * 100);
  const adoption = proposals.length ? (adopted.length / proposals.length) * 100 : 50;
  const score = 0.5 * approvalRate * 100 + 0.3 * throughput + 0.2 * adoption;
  return {
    key: "execution",
    label: "Swarm execution",
    weight: WEIGHTS.execution,
    score,
    detail: `${approved.length}/${reviewed.length} drafts approved, ${recent.length - reviewed.length} pending, ${adopted.length}/${proposals.length} strategy proposals adopted`,
  };
}

export function computeGrade(state: SwarmState, metrics: MetricsSnapshot): DailyGrade {
  const baseline = findBaseline(state.metricsHistory, metrics.ts);
  const components = [
    scorePrice(metrics, baseline),
    scoreRevenue(metrics),
    scoreVolume(metrics, state.metricsHistory),
    scoreExecution(state, metrics.ts),
  ];
  const score = components.reduce((s, c) => s + c.score * c.weight, 0);
  const weakest = [...components].sort((a, b) => a.score - b.score)[0];
  const letter = letterFor(score);
  const summary = `${letter} (${score.toFixed(1)}). Weakest lever: ${weakest.label.toLowerCase()} at ${weakest.score.toFixed(0)}/100. ${metrics.source === "live" ? "Live data." : metrics.source === "partial" ? "Partial data - one upstream failed." : "Synthetic data - upstreams unreachable."}`;
  return {
    id: newId("grade"),
    date: utcDate(metrics.ts),
    ts: metrics.ts,
    score,
    letter,
    components,
    metrics,
    baseline,
    summary,
  };
}
