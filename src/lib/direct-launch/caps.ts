import type { DirectLaunch, SwarmState } from "@/lib/types";

/**
 * Hard code level caps for launches that leave the Stonklauncher: LAURA's
 * own tax tokens seeded straight into a vDEX pool, and Pons launches. Like
 * LAUNCH_CAPS and FORGE_CAPS these fail closed and never bend to a prompt.
 * Client bundle safe: no node or viem imports.
 */
export const DIRECT_LAUNCH_CAPS = {
  /** Direct and Pons launches together, per rolling 24h */
  maxPerDay: 2,
  /** Per rolling 7 days */
  maxPerWeek: 7,
  /** Minimum hours between two launches on these rails */
  minGapHours: 4,
  /** Specs waiting to deploy at once (approved or deploying) */
  maxQueued: 2,
  /** ETH the whole launch may spend on fees, dev buys and gas, per launch */
  maxEthPerLaunch: 0.004,
  /** Pons opening buy ceiling (the launch fee comes on top) */
  maxDevBuyEth: 0.002,
  /** Never spend the wallet under this ETH balance (shared floor with the treasury caps) */
  treasuryFloorEth: 0.35,
  /** Refuse a direct deploy whose estimated gas for the whole five transaction sequence exceeds this much ETH (about 40x today's Robinhood Chain gas) */
  maxDeployCostEth: 0.005,
} as const;

/** Pons V2 launch fee, read live before every launch; this is the figure the caps reason with. */
export const PONS_LAUNCH_FEE_ETH = 0.0005;

const DAY_MS = 24 * 3600_000;

export interface DirectCapacity {
  open: boolean;
  reason: string;
  /** When the next launch could go out if nothing else changes (0 = now) */
  nextWindowAt: number;
  launchedToday: number;
  launchedThisWeek: number;
}

/** Pure caps math over the direct launch ledger (deployed records only). */
export function directCapacity(launches: DirectLaunch[], now = Date.now()): DirectCapacity {
  const deployed = launches.filter((l) => l.deployedAt !== null && (l.status === "deployed" || l.status === "deploying"));
  const today = deployed.filter((l) => (l.deployedAt ?? 0) > now - DAY_MS);
  const week = deployed.filter((l) => (l.deployedAt ?? 0) > now - 7 * DAY_MS);
  const last = deployed.reduce((m, l) => Math.max(m, l.deployedAt ?? 0), 0);
  const gapMs = DIRECT_LAUNCH_CAPS.minGapHours * 3600_000;
  const base = { launchedToday: today.length, launchedThisWeek: week.length };
  if (launches.some((l) => l.status === "deploying")) {
    return { open: false, reason: "a direct launch is deploying right now", nextWindowAt: now + 60_000, ...base };
  }
  if (last && now - last < gapMs) {
    return { open: false, reason: `last direct launch ${((now - last) / 60_000).toFixed(0)} min ago; min gap ${DIRECT_LAUNCH_CAPS.minGapHours}h`, nextWindowAt: last + gapMs, ...base };
  }
  if (today.length >= DIRECT_LAUNCH_CAPS.maxPerDay) {
    const oldest = today.reduce((m, l) => Math.min(m, l.deployedAt ?? now), now);
    return { open: false, reason: `${today.length} direct launches in 24h (cap ${DIRECT_LAUNCH_CAPS.maxPerDay})`, nextWindowAt: oldest + DAY_MS, ...base };
  }
  if (week.length >= DIRECT_LAUNCH_CAPS.maxPerWeek) {
    const oldest = week.reduce((m, l) => Math.min(m, l.deployedAt ?? now), now);
    return { open: false, reason: `${week.length} direct launches in 7 days (cap ${DIRECT_LAUNCH_CAPS.maxPerWeek})`, nextWindowAt: oldest + 7 * DAY_MS, ...base };
  }
  return { open: true, reason: "", nextWindowAt: 0, ...base };
}

/** Specs waiting for the executor (approved or mid deploy). */
export function queuedDirectLaunches(state: SwarmState): DirectLaunch[] {
  return (state.directLaunches ?? []).filter((l) => l.status === "approved" || l.status === "deploying");
}

/** One paragraph of real numbers for Mint's prompt. */
export function directCapacityDigest(state: SwarmState, now = Date.now()): string {
  const launches = state.directLaunches ?? [];
  const cap = directCapacity(launches, now);
  const queued = queuedDirectLaunches(state);
  const lines = [
    `Direct and Pons launches: ${cap.launchedToday} in the last 24h (cap ${DIRECT_LAUNCH_CAPS.maxPerDay}), ${cap.launchedThisWeek} in 7 days (cap ${DIRECT_LAUNCH_CAPS.maxPerWeek}), minimum ${DIRECT_LAUNCH_CAPS.minGapHours}h apart.`,
    cap.open ? "Window: OPEN now." : `Window: closed (${cap.reason}); reopens about ${new Date(cap.nextWindowAt).toISOString().slice(11, 16)} UTC.`,
    `Queue: ${queued.length} spec(s) waiting (limit ${DIRECT_LAUNCH_CAPS.maxQueued}).`,
    `Spend ceiling per launch ${DIRECT_LAUNCH_CAPS.maxEthPerLaunch} ETH all in; Pons fee ${PONS_LAUNCH_FEE_ETH} ETH plus an opening buy of at most ${DIRECT_LAUNCH_CAPS.maxDevBuyEth} ETH; direct launches cost gas only (the whole supply seeds the pool, no ETH side).`,
  ];
  return lines.join("\n");
}
