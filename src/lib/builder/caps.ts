import type { SwarmState, UtilityProject } from "@/lib/types";

/**
 * Pure builder caps + eligibility math, shared by the server executor
 * (src/lib/builder/executor.ts) and any console surface. No node/viem
 * imports here; this file must stay client-bundle safe.
 *
 * HARD CODE-LEVEL CAPS. The builder's autonomy grant rests on these the same
 * way launches rest on LAUNCH_CAPS and treasury buys on TREASURY_CAPS: they
 * fail closed and never bend. Env overrides (executor-side) can only SHRINK
 * these numbers, never raise them.
 */
export const BUILDER_CAPS = {
  /** Max ETH-equivalent per single supply acquisition (curve WETH or pool ETH) */
  maxEthPerAcquisition: 0.002,
  /** Max total ETH-equivalent spent on acquisitions per rolling 24h */
  maxEthPer24h: 0.004,
  /** Minimum hours between acquisitions */
  minAcquisitionGapHours: 12,
  /** Skip dust acquisitions smaller than this */
  minEthPerAcquisition: 0.0003,
  /** Never spend below this wallet ETH balance (shared floor with TREASURY_CAPS) */
  treasuryFloorEth: 0.35,
  /** Slippage guard on quoted token output (basis points) */
  slippageBps: 500,
  /** Max utility projects in flight (pending/approved, not yet shipped) */
  maxActiveProjects: 2,
  /** One utility project per token, ever (rejected/failed ones free the slot) */
  maxProjectsPerToken: 1,
  /** Max template contract deploys per rolling 7 days */
  maxDeploysPerWeek: 2,
  /** Candidate tokens must be at least this old before the builder serves them */
  minTokenAgeHours: 24,
  /** Faucet runway bounds: the acquired bag must cover at least/at most this many claims */
  faucetMinClaims: 20,
  faucetMaxClaims: 1000,
} as const;

export type BuilderCaps = { [K in keyof typeof BUILDER_CAPS]: number };

const DAY_MS = 24 * 3600_000;
const WEEK_MS = 7 * DAY_MS;

/** Projects still occupying a slot (anything not rejected/failed). */
export function activeUtilityProjects(state: SwarmState): UtilityProject[] {
  return (state.utilityProjects ?? []).filter((p) => p.status === "pending" || p.status === "approved");
}

/** True when `token` already has a live or shipped utility project. */
export function tokenAlreadyServed(state: SwarmState, token: string): boolean {
  const t = token.toLowerCase();
  return (state.utilityProjects ?? []).some(
    (p) => p.tokenAddress.toLowerCase() === t && p.status !== "rejected" && p.status !== "failed",
  );
}

export interface AcquisitionEligibility {
  eligible: boolean;
  reason: string;
  /** ETH-equivalent the caps allow for the next acquisition right now */
  amountEth: number;
  /** ETH-equivalent spent on acquisitions in the rolling 24h window */
  spent24hEth: number;
  /** Earliest timestamp the next acquisition can fire (cap-based; 0 = now) */
  nextEligibleAt: number;
}

/** Pure caps math over the acquisition ledger; balances are checked at send time. */
export function acquisitionEligibility(
  state: SwarmState,
  now = Date.now(),
  caps: BuilderCaps = BUILDER_CAPS,
): AcquisitionEligibility {
  const acqs = (state.utilityProjects ?? [])
    .map((p) => p.acquisition)
    .filter((a): a is NonNullable<typeof a> => a !== null);
  const spendOf = (a: { ethIn: number; wethIn: number }) => a.ethIn + a.wethIn;
  const lastAt = acqs.reduce((max, a) => Math.max(max, a.ts), 0);
  const gapMs = caps.minAcquisitionGapHours * 3600_000;
  const inWindow = acqs.filter((a) => a.ts > now - DAY_MS);
  const spent24h = inWindow.reduce((s, a) => s + spendOf(a), 0);

  const gapFreeAt = lastAt ? lastAt + gapMs : 0;
  const capBound = spent24h + caps.minEthPerAcquisition > caps.maxEthPer24h;
  const oldestInWindow = inWindow.reduce((min, a) => Math.min(min, a.ts), now);
  const capFreeAt = capBound ? oldestInWindow + DAY_MS : 0;
  const nextEligibleAt = Math.max(gapFreeAt, capFreeAt);

  if (now < gapFreeAt) {
    return {
      eligible: false,
      reason: `last acquisition ${((now - lastAt) / 3600_000).toFixed(1)}h ago, min gap ${caps.minAcquisitionGapHours}h`,
      amountEth: 0,
      spent24hEth: spent24h,
      nextEligibleAt,
    };
  }
  const remaining = caps.maxEthPer24h - spent24h;
  if (remaining < caps.minEthPerAcquisition) {
    return {
      eligible: false,
      reason: `24h spend ${spent24h.toFixed(4)} ETH leaves under ${caps.minEthPerAcquisition} ETH of the ${caps.maxEthPer24h} ETH cap`,
      amountEth: 0,
      spent24hEth: spent24h,
      nextEligibleAt,
    };
  }
  return {
    eligible: true,
    reason: "",
    amountEth: Math.min(caps.maxEthPerAcquisition, remaining),
    spent24hEth: spent24h,
    nextEligibleAt: 0,
  };
}

export interface DeployEligibility {
  eligible: boolean;
  reason: string;
}

/** Weekly deploy budget over the project deploy records. */
export function deployEligibility(
  state: SwarmState,
  now = Date.now(),
  caps: BuilderCaps = BUILDER_CAPS,
): DeployEligibility {
  const deploys = (state.utilityProjects ?? [])
    .map((p) => p.deploy)
    .filter((d): d is NonNullable<typeof d> => d !== null)
    .filter((d) => d.ts > now - WEEK_MS);
  if (deploys.length >= caps.maxDeploysPerWeek) {
    return { eligible: false, reason: `${deploys.length} deploys in the last 7d, cap ${caps.maxDeploysPerWeek}` };
  }
  return { eligible: true, reason: "" };
}

/** Gate for proposing a NEW project (mirrors mintGate). */
export function builderGate(state: SwarmState): { blocked: boolean; reason: string } {
  const active = activeUtilityProjects(state);
  if (active.length >= BUILDER_CAPS.maxActiveProjects) {
    return {
      blocked: true,
      reason: `${active.length} utility project(s) already in flight (cap ${BUILDER_CAPS.maxActiveProjects}); ship or clear those first`,
    };
  }
  return { blocked: false, reason: "" };
}
