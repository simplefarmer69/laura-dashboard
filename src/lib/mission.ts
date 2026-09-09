import type { MetricsSnapshot, MilestoneRecord, SwarmState } from "@/lib/types";
import { pushEvent } from "@/lib/store";

export const TARGET_MARKET_CAP_USD = 1_000_000_000;

export const MILESTONES: { id: string; label: string; marketCapUsd: number }[] = [
  { id: "m25", label: "$25M", marketCapUsd: 25_000_000 },
  { id: "m50", label: "$50M", marketCapUsd: 50_000_000 },
  { id: "m100", label: "$100M", marketCapUsd: 100_000_000 },
  { id: "m250", label: "$250M", marketCapUsd: 250_000_000 },
  { id: "m500", label: "$500M", marketCapUsd: 500_000_000 },
  { id: "m1b", label: "$1B · DAIO mandate", marketCapUsd: TARGET_MARKET_CAP_USD },
];

export interface MissionStatus {
  marketCapUsd: number;
  targetUsd: number;
  /** 0..1 on a log scale from $1M to $1B so early progress is visible */
  progress: number;
  multipleToTarget: number;
  athMarketCapUsd: number;
  next: { label: string; marketCapUsd: number; multiple: number } | null;
  reached: MilestoneRecord[];
  daioMandateActive: boolean;
}

export function missionStatus(state: SwarmState, latest: MetricsSnapshot | null): MissionStatus {
  const mcap = latest?.marketCapUsd ?? 0;
  const ath = state.metricsHistory.reduce((m, s) => Math.max(m, s.marketCapUsd), mcap);
  const floor = 1_000_000;
  const progress =
    mcap <= floor
      ? 0
      : Math.min(1, Math.log(mcap / floor) / Math.log(TARGET_MARKET_CAP_USD / floor));
  const next = MILESTONES.find((m) => m.marketCapUsd > mcap) ?? null;
  return {
    marketCapUsd: mcap,
    targetUsd: TARGET_MARKET_CAP_USD,
    progress,
    multipleToTarget: mcap > 0 ? TARGET_MARKET_CAP_USD / mcap : Infinity,
    athMarketCapUsd: ath,
    next: next ? { ...next, multiple: mcap > 0 ? next.marketCapUsd / mcap : Infinity } : null,
    reached: state.milestones,
    daioMandateActive: state.milestones.some((m) => m.id === "m1b"),
  };
}

/** Records any newly crossed milestones and emits events. Returns the ones crossed this call. */
export function checkMilestones(state: SwarmState, metrics: MetricsSnapshot): MilestoneRecord[] {
  const crossed: MilestoneRecord[] = [];
  for (const m of MILESTONES) {
    if (metrics.marketCapUsd < m.marketCapUsd) continue;
    if (state.milestones.some((r) => r.id === m.id)) continue;
    const record: MilestoneRecord = {
      id: m.id,
      label: m.label,
      marketCapUsd: m.marketCapUsd,
      reachedAt: metrics.ts,
      priceUsd: metrics.priceUsd,
    };
    state.milestones.push(record);
    crossed.push(record);
    pushEvent(state, {
      kind: "milestone.reached",
      agentId: "system",
      title: `Milestone reached: ${m.label} market cap`,
      detail:
        m.id === "m1b"
          ? "The $1B condition is met. LAURA's DAIO leadership mandate is now active pending foundation ratification."
          : `Market cap crossed ${m.label} at $${metrics.priceUsd.toFixed(5)} per token.`,
      refId: record.id,
    });
  }
  return crossed;
}

export function missionDigest(status: MissionStatus): string {
  const mcap = `$${(status.marketCapUsd / 1_000_000).toFixed(2)}M`;
  const next = status.next
    ? `next milestone ${status.next.label} (${status.next.multiple.toFixed(1)}x from here)`
    : "all milestones reached";
  return `Market cap ${mcap}; ${(status.multipleToTarget).toFixed(0)}x to the $1B DAIO mandate; ${next}; ATH ${`$${(status.athMarketCapUsd / 1_000_000).toFixed(2)}M`}.`;
}
