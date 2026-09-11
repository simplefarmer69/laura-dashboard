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

/**
 * Collapse repeated "Added in vN: …" blocks whose text is identical (the
 * deterministic coach fallback stacked them on bd across eight cycles on
 * 2026-09-11). Keeps the first occurrence, drops exact repeats, leaves every
 * other paragraph untouched. Returns the cleaned text and how many blocks went.
 */
export function dedupeStrategyAppends(strategy: string): { text: string; removed: number } {
  const blocks = strategy.split(/\n{2,}/);
  const seen = new Set<string>();
  let removed = 0;
  const kept = blocks.filter((block) => {
    const m = /^Added in v\d+:\s*([\s\S]+)$/.exec(block.trim());
    if (!m) return true;
    const key = m[1].replace(/\s+/g, " ").trim();
    if (seen.has(key)) {
      removed += 1;
      return false;
    }
    seen.add(key);
    return true;
  });
  return { text: removed ? kept.join("\n\n") : strategy, removed };
}

/** Self-heal pass: applies dedupeStrategyAppends to every agent, as a versioned adoption so history stays honest. */
export function healDuplicatedStrategies(state: SwarmState): string[] {
  const healed: string[] = [];
  for (const agent of state.agents) {
    const { text, removed } = dedupeStrategyAppends(agent.strategy);
    if (removed === 0) continue;
    adoptStrategy(state, agent, text, `Self-heal: removed ${removed} duplicated "Added in vN" block(s) left by the fallback coach`, "coach");
    healed.push(`${agent.id} (-${removed})`);
  }
  return healed;
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
