import { pushEvent } from "@/lib/store";
import type { AgentId, GradeComponent, Settings, SwarmState } from "@/lib/types";

const DAY_MS = 86_400_000;

/** Hard rails the tuner can never leave, whatever the data says. */
export const TUNER_RAILS = {
  minCycleMinutes: 45,
  maxCycleMinutes: 360,
  /** Step size for cadence adjustments */
  cycleStepMinutes: 30,
  minDraftsPerCycle: 3,
  maxDraftsPerCycle: 8,
  /** Minimum reviewed drafts before approval-rate rules fire */
  minReviewedSample: 5,
} as const;

export interface TuningChange {
  key: "cycleIntervalMinutes" | "maxDraftsPerCycle";
  from: number;
  to: number;
  reason: string;
}

interface TuningSignals {
  pending: number;
  oldestPendingHours: number;
  reviewed3d: number;
  approvalRate3d: number;
  gradeTrend3d: number | null;
}

function signals(state: SwarmState): TuningSignals {
  const now = Date.now();
  const pendingDrafts = state.drafts.filter((d) => d.status === "pending");
  const oldest = pendingDrafts.reduce<number>((min, d) => Math.min(min, d.createdAt), now);
  const recent = state.drafts.filter((d) => d.createdAt >= now - 3 * DAY_MS && d.status !== "pending");
  const approved = recent.filter((d) => d.status === "approved" || d.status === "published");
  const grades = state.grades.slice(-3);
  return {
    pending: pendingDrafts.length,
    oldestPendingHours: (now - oldest) / 3_600_000,
    reviewed3d: recent.length,
    approvalRate3d: recent.length > 0 ? approved.length / recent.length : 0.5,
    gradeTrend3d: grades.length >= 3 ? grades[grades.length - 1].score - grades[0].score : null,
  };
}

/**
 * Deterministic feedback controller over the swarm's own operating data.
 * Runs at most once per UTC day (caller enforces via state.lastTuneDate) and
 * only moves settings inside TUNER_RAILS. Every change is logged with the
 * numbers that justified it, so the operator can audit or revert in Settings.
 */
export function tuneSettings(state: SwarmState): TuningChange[] {
  const s = signals(state);
  const changes: TuningChange[] = [];
  const set = state.settings;

  /* Draft budget: track operator review throughput. A queue nobody clears is
     wasted work and drags the execution grade; a clearing queue with a high
     approval rate means the swarm can safely produce more. */
  if (s.pending > 2 * set.maxDraftsPerCycle && set.maxDraftsPerCycle > TUNER_RAILS.minDraftsPerCycle) {
    changes.push({
      key: "maxDraftsPerCycle",
      from: set.maxDraftsPerCycle,
      to: set.maxDraftsPerCycle - 1,
      reason: `${s.pending} drafts pending (>2x budget), oldest ${s.oldestPendingHours.toFixed(0)}h — producing faster than review capacity`,
    });
  } else if (
    s.pending <= Math.ceil(set.maxDraftsPerCycle / 2) &&
    s.reviewed3d >= TUNER_RAILS.minReviewedSample &&
    s.approvalRate3d >= 0.7 &&
    set.maxDraftsPerCycle < TUNER_RAILS.maxDraftsPerCycle
  ) {
    changes.push({
      key: "maxDraftsPerCycle",
      from: set.maxDraftsPerCycle,
      to: set.maxDraftsPerCycle + 1,
      reason: `Queue is clearing (${s.pending} pending) with ${(s.approvalRate3d * 100).toFixed(0)}% approval over ${s.reviewed3d} reviews — room for more output`,
    });
  }

  /* Cadence: more shots on goal when the grade is sliding and the queue can
     absorb them; slow down when output is flooding an unattended queue. */
  if (
    s.gradeTrend3d !== null &&
    s.gradeTrend3d <= -3 &&
    s.pending < 2 * set.maxDraftsPerCycle &&
    set.cycleIntervalMinutes > TUNER_RAILS.minCycleMinutes
  ) {
    changes.push({
      key: "cycleIntervalMinutes",
      from: set.cycleIntervalMinutes,
      to: Math.max(TUNER_RAILS.minCycleMinutes, set.cycleIntervalMinutes - TUNER_RAILS.cycleStepMinutes),
      reason: `Grade fell ${Math.abs(s.gradeTrend3d).toFixed(1)} pts over 3 days — increasing cycle frequency for faster iteration`,
    });
  } else if (s.pending > 3 * set.maxDraftsPerCycle && set.cycleIntervalMinutes < TUNER_RAILS.maxCycleMinutes) {
    changes.push({
      key: "cycleIntervalMinutes",
      from: set.cycleIntervalMinutes,
      to: Math.min(TUNER_RAILS.maxCycleMinutes, set.cycleIntervalMinutes + TUNER_RAILS.cycleStepMinutes),
      reason: `${s.pending} drafts pending (>3x budget) — slowing cadence until reviewers catch up`,
    });
  }

  for (const c of changes) {
    if (c.key === "cycleIntervalMinutes") set.cycleIntervalMinutes = c.to;
    else set.maxDraftsPerCycle = c.to;
    pushEvent(state, {
      kind: "tuner.adjusted",
      agentId: "system",
      title: `Auto-tune: ${c.key} ${c.from} → ${c.to}`,
      detail: c.reason,
      refId: null,
    });
  }
  return changes;
}

/** Which producer's output most directly targets each grade lever. */
const LEVER_AGENT: Record<GradeComponent["key"], AgentId> = {
  /* Catalyst exists to run experiments against the weakest lever; price is the
     weakest by far, so it gets first call on the draft budget when price lags. */
  price: "growth",
  revenue: "steward",
  volume: "bd",
  execution: "analyst",
};

/**
 * Orders producers so the shared draft budget is spent where the data says it
 * pays: the agent targeting today's weakest grade lever first, then the rest
 * by recent approval rate (agents reviewers trust get budget before agents
 * whose work gets rejected).
 */
export function producerOrder(
  state: SwarmState,
  producers: AgentId[],
  weakestLever: GradeComponent["key"],
): AgentId[] {
  const rate = (id: AgentId): number => {
    const a = state.agents.find((x) => x.id === id);
    if (!a) return 0.5;
    const reviewed = a.stats.approved + a.stats.rejected;
    return reviewed >= 3 ? a.stats.approved / reviewed : 0.5;
  };
  const first = LEVER_AGENT[weakestLever];
  return [...producers].sort((a, b) => {
    if (a === first) return -1;
    if (b === first) return 1;
    return rate(b) - rate(a);
  });
}

/**
 * How many strategy proposals the coach may file this cycle:
 * 0 while proposals are already stacked up unreviewed, 2 when the grade is in
 * a confirmed slide, otherwise 1 (do not churn strategies that are working).
 */
export function coachProposalBudget(state: SwarmState): number {
  const pendingProposals = state.proposals.filter((p) => p.status === "pending").length;
  if (pendingProposals >= 2) return 0;
  const grades = state.grades.slice(-3);
  const trend = grades.length >= 3 ? grades[grades.length - 1].score - grades[0].score : 0;
  return trend <= -3 ? 2 : 1;
}

/**
 * Speaking cadence: launches are LAURA's voice, so the gate paces speech, not
 * just deploys. Two paces, picked by settings.mintFreedom:
 *   freedom ON (default): 2h cooldown after the last deploy, up to 4 open
 *     specs. The gate only prevents a runaway queue; the LAUNCH_CAPS daily
 *     deploy ceiling does the real bounding.
 *   freedom OFF (kill switch): the legacy pace. 12h cooldown, 2 open specs,
 *     roughly 2 speech launches/day.
 * Env overrides (checked on every call, clamped): MINT_COOLDOWN_HOURS,
 * MINT_QUEUE_LIMIT. This gate sits inside the executor's inviolable hard
 * caps (LAUNCH_CAPS deploys/day + spend/deploy); it shapes cadence, they
 * stop runaways.
 */
const SPEECH_COOLDOWN_HOURS = 12;
const FREEDOM_COOLDOWN_HOURS = 2;
const OPEN_QUEUE_LIMIT = 2;
const FREEDOM_QUEUE_LIMIT = 4;

function gateEnv(name: string): number | null {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : null;
}

/** Open-spec (pending + approved) ceiling before the gate blocks new designs. */
export function mintQueueLimit(settings: Settings): number {
  const def = settings.mintFreedom ? FREEDOM_QUEUE_LIMIT : OPEN_QUEUE_LIMIT;
  return Math.min(12, Math.max(1, Math.round(gateEnv("MINT_QUEUE_LIMIT") ?? def)));
}

/** Hours after the last deploy before the next spec may be designed. */
export function mintCooldownHours(settings: Settings): number {
  const def = settings.mintFreedom ? FREEDOM_COOLDOWN_HOURS : SPEECH_COOLDOWN_HOURS;
  return Math.min(48, gateEnv("MINT_COOLDOWN_HOURS") ?? def);
}

export function mintGate(state: SwarmState): { blocked: boolean; reason: string } {
  const queueLimit = mintQueueLimit(state.settings);
  const cooldownH = mintCooldownHours(state.settings);
  const open = state.launches.filter((l) => l.status === "pending" || l.status === "approved").length;
  if (open >= queueLimit) {
    return { blocked: true, reason: `${open} launch specs already await review or deploy (queue limit ${queueLimit})` };
  }
  const lastDeploy = state.launches
    .filter((l) => l.status === "deployed" && l.deployedAt !== null)
    .reduce<number>((max, l) => Math.max(max, l.deployedAt ?? 0), 0);
  const sinceH = (Date.now() - lastDeploy) / 3_600_000;
  if (lastDeploy > 0 && cooldownH > 0 && sinceH < cooldownH) {
    return {
      blocked: true,
      reason: `Last launch spoke ${sinceH.toFixed(1)}h ago (cooldown ${cooldownH}h). Letting it work the curve before LAURA says the next thing`,
    };
  }
  return { blocked: false, reason: "" };
}
