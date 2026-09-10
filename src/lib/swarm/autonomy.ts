import { pushEvent, updateState } from "@/lib/store";
import { applyProposal } from "@/lib/swarm/strategy";
import type { SwarmState } from "@/lib/types";

export const AUTO_APPROVE_NOTE = "Auto-approved: full autonomy enabled";

/** True when anything is still sitting in a pending status awaiting review. */
export function hasPendingApprovals(state: SwarmState): boolean {
  return (
    state.drafts.some((d) => d.status === "pending") ||
    state.proposals.some((p) => p.status === "pending") ||
    state.launches.some((l) => l.status === "pending")
  );
}

/**
 * Sweeps every pending draft, strategy proposal and launch spec to approved so
 * nothing waits on a human. Idempotent: only "pending" items move, so re-running
 * is a no-op. This removes review gates, not safety rails — external publishing
 * and the launch executor's hard caps (deploys/day, spend/deploy, live pad
 * bounds) are untouched, and the operator can still reject items afterwards
 * through the existing API routes.
 */
export async function sweepPendingApprovals(): Promise<number> {
  return updateState((state) => {
    if (!state.settings.autoApproveProposals) return 0;
    let swept = 0;
    for (const draft of state.drafts) {
      if (draft.status !== "pending") continue;
      draft.status = "approved";
      draft.reviewedAt = Date.now();
      draft.reviewerNote = AUTO_APPROVE_NOTE;
      const agent = state.agents.find((a) => a.id === draft.agentId);
      if (agent) agent.stats.approved += 1;
      pushEvent(state, {
        kind: "draft.approved",
        agentId: "system",
        title: `Auto-approved: ${draft.title}`,
        detail: `${agent?.name ?? draft.agentId} · ${draft.kind} for ${draft.channel} · ${AUTO_APPROVE_NOTE}`,
        refId: draft.id,
      });
      swept += 1;
    }
    for (const proposal of state.proposals) {
      if (proposal.status !== "pending") continue;
      applyProposal(state, proposal, AUTO_APPROVE_NOTE, "coach");
      proposal.autoApplied = true;
      swept += 1;
    }
    for (const launch of state.launches) {
      if (launch.status !== "pending") continue;
      launch.status = "approved";
      launch.reviewedAt = Date.now();
      launch.reviewerNote = AUTO_APPROVE_NOTE;
      const mint = state.agents.find((a) => a.id === "mint");
      if (mint) mint.stats.approved += 1;
      pushEvent(state, {
        kind: "launch.approved",
        agentId: "system",
        title: `Auto-approved ${launch.name} ($${launch.symbol})`,
        detail: `${AUTO_APPROVE_NOTE}; deploys within hard caps when the wallet is funded.`,
        refId: launch.id,
      });
      swept += 1;
    }
    return swept;
  });
}
