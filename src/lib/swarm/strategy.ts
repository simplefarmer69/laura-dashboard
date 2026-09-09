import { pushEvent } from "@/lib/store";
import type { Agent, StrategyProposal, SwarmState } from "@/lib/types";

export function latestGradeScore(state: SwarmState): number | null {
  return state.grades.at(-1)?.score ?? null;
}

/**
 * Single path for every strategy change (manual edit, approved proposal, auto-apply)
 * so version history and before/after grades stay consistent.
 */
export function adoptStrategy(
  state: SwarmState,
  agent: Agent,
  newStrategy: string,
  reason: string,
  actor: "operator" | "coach",
): void {
  const grade = latestGradeScore(state);
  agent.history.push({
    version: agent.strategyVersion,
    strategy: agent.strategy,
    adoptedAt: agent.versionAdoptedAt ?? 0,
    reason: `Superseded: ${reason}`,
    gradeAtAdoption: agent.gradeAtVersionAdoption,
    gradeAtRetirement: grade,
  });
  agent.strategy = newStrategy;
  agent.strategyVersion += 1;
  agent.versionAdoptedAt = Date.now();
  agent.gradeAtVersionAdoption = grade;
  pushEvent(state, {
    kind: actor === "operator" && !reason.startsWith("Approved") ? "strategy.edited" : "proposal.adopted",
    agentId: actor === "operator" ? "operator" : "coach",
    title: `${agent.name} moved to strategy v${agent.strategyVersion}`,
    detail: reason,
    refId: agent.id,
  });
}

export function applyProposal(
  state: SwarmState,
  proposal: StrategyProposal,
  reason: string,
  actor: "operator" | "coach",
): void {
  const agent = state.agents.find((a) => a.id === proposal.agentId);
  if (!agent) throw new Error(`agent ${proposal.agentId} missing`);
  adoptStrategy(state, agent, proposal.proposedStrategy, reason, actor);
  proposal.status = "approved";
  proposal.reviewedAt = Date.now();
}
