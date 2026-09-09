import type { MetricsSnapshot, MilestoneRecord, SwarmState } from "@/lib/types";
import { pushEvent } from "@/lib/store";
import { MILESTONES } from "@/lib/mission-status";

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

