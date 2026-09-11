import { LAUNCH_CAPS } from "@/lib/launchpad/service";
import { laneClosedReason } from "@/lib/launchpad/lanes";
import type { LaunchProposal } from "@/lib/types";

const DAY_MS = 24 * 3600 * 1000;

export interface DeployCapacity {
  /** Deploys landed in the rolling 24h window */
  used: number;
  max: number;
  minGapMs: number;
  lastDeployAt: number | null;
  /** When the next deploy may go out; `now` or earlier when the window is open */
  nextWindowAt: number;
  open: boolean;
  /** Human reason the window is shut (null when open) */
  reason: string | null;
}

/**
 * Pure-math view of the deploy window: the rolling 24h cap and the spacing
 * rule between consecutive deploys. Shared by the executor (the gate), Mint's
 * prompt digest, the launchpad API and the console, so every surface quotes
 * the same "next window" instant.
 */
export function deployCapacity(launches: LaunchProposal[], now = Date.now()): DeployCapacity {
  const minGapMs = LAUNCH_CAPS.minDeployGapHours * 3600 * 1000;
  const deployedAts = launches
    .filter((l) => l.status === "deployed" && (l.deployedAt ?? 0) > 0)
    .map((l) => l.deployedAt as number)
    .sort((a, b) => a - b);
  const recent = deployedAts.filter((t) => t > now - DAY_MS);
  const lastDeployAt = deployedAts.length ? deployedAts[deployedAts.length - 1] : null;
  const capOpensAt = recent.length >= LAUNCH_CAPS.maxDeploysPerDay ? recent[recent.length - LAUNCH_CAPS.maxDeploysPerDay] + DAY_MS : now;
  const gapOpensAt = lastDeployAt ? lastDeployAt + minGapMs : now;
  const nextWindowAt = Math.max(now, capOpensAt, gapOpensAt);
  const open = nextWindowAt <= now;
  let reason: string | null = null;
  if (!open) {
    reason =
      capOpensAt > now
        ? `Daily cap reached: ${recent.length}/${LAUNCH_CAPS.maxDeploysPerDay} deploys in the rolling 24h; next window ~${stamp(nextWindowAt)}`
        : `Spacing: launches go out at least ${LAUNCH_CAPS.minDeployGapHours}h apart; next window ~${stamp(nextWindowAt)}`;
  }
  return { used: recent.length, max: LAUNCH_CAPS.maxDeploysPerDay, minGapMs, lastDeployAt, nextWindowAt, open, reason };
}

/** Approved specs in executor order; `openOnly` drops lanes closed at `now` (the executor's own view). */
export function deployQueue(launches: LaunchProposal[], now = Date.now(), openOnly = true): LaunchProposal[] {
  return launches
    .filter((l) => l.status === "approved" && (!openOnly || laneClosedReason(l.lane, new Date(now)) === null))
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt);
}

const LANE_PROBE_STEP_MS = 15 * 60_000;
const PROJECTION_HORIZON_MS = 7 * DAY_MS;

/**
 * Projected deploy instant for every queued spec, simulating the executor:
 * slots open at the cap/spacing window, the first spec whose lane is open at
 * that slot takes it (weekend stock lanes wait, crypto lanes go ahead), and
 * the cursor moves a spacing gap on, rolling over the daily cap. Pure
 * projection for display; the executor re-checks everything live.
 */
export function projectedDeploys(launches: LaunchProposal[], now = Date.now()): Map<string, number> {
  const out = new Map<string, number>();
  const cap = deployCapacity(launches, now);
  const recent = launches
    .filter((l) => l.status === "deployed" && (l.deployedAt ?? 0) > now - DAY_MS)
    .map((l) => l.deployedAt as number)
    .sort((a, b) => a - b);
  const waiting = deployQueue(launches, now, false);
  let t = cap.nextWindowAt;
  while (waiting.length > 0 && t - now < PROJECTION_HORIZON_MS) {
    while (recent.filter((d) => d > t - DAY_MS).length >= LAUNCH_CAPS.maxDeploysPerDay) {
      const oldest = recent.filter((d) => d > t - DAY_MS)[0];
      t = Math.max(t, oldest + DAY_MS);
    }
    const idx = waiting.findIndex((l) => laneClosedReason(l.lane, new Date(t)) === null);
    if (idx === -1) {
      t += LANE_PROBE_STEP_MS;
      continue;
    }
    const [next] = waiting.splice(idx, 1);
    out.set(next.id, t);
    recent.push(t);
    recent.sort((a, b) => a - b);
    t += cap.minGapMs;
  }
  return out;
}

/**
 * When a spec designed right now would actually deploy: the slot after every
 * already-queued spec. Mint's lane menu and the lane resolver evaluate stock
 * lane availability at this instant, so a Friday-morning NVDA pick with a
 * full daily cap (which would not deploy before the Friday 20:00 UTC close)
 * resolves to a crypto lane instead of waiting until Monday.
 */
export function nextDesignSlotAt(launches: LaunchProposal[], now = Date.now()): number {
  const probe: LaunchProposal = {
    ...(launches[0] ?? ({} as LaunchProposal)),
    id: "__design_probe",
    lane: "weth",
    status: "approved",
    priority: -1,
    createdAt: now,
    deployedAt: null,
  } as LaunchProposal;
  const projected = projectedDeploys([...launches, probe], now);
  return projected.get(probe.id) ?? deployCapacity(launches, now).nextWindowAt;
}

/** Deploy window + per-spec projection for the console and the published snapshot. */
export function launchQueueInfo(launches: LaunchProposal[], now = Date.now()) {
  const capacity = deployCapacity(launches, now);
  return {
    used24h: capacity.used,
    max: capacity.max,
    minGapHours: LAUNCH_CAPS.minDeployGapHours,
    open: capacity.open,
    nextWindowAt: capacity.nextWindowAt,
    reason: capacity.reason,
    projected: Object.fromEntries(projectedDeploys(launches, now)),
  };
}

function stamp(at: number): string {
  return `${new Date(at).toISOString().slice(0, 16)}Z`;
}
