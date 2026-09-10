import type { SwarmState } from "@/lib/types";

/**
 * Pure treasury-ops caps + eligibility math, shared by the server module
 * (treasury.ts) and the console economics panel. No node/viem imports here —
 * this file must stay client-bundle safe.
 *
 * HARD CODE-LEVEL CAPS. These are the safety rails the operator's autonomy
 * grant rests on — like LAUNCH_CAPS, they fail closed and never bend.
 */
export const TREASURY_CAPS = {
  /** Max ETH per single buy */
  maxEthPerBuy: 0.005,
  /** Max total ETH spent on buys per rolling 24h */
  maxEthPer24h: 0.01,
  /** Minimum hours between buys */
  minBuyGapHours: 6,
  /** Never spend below this ETH balance — launch gas + deploys stay funded */
  treasuryFloorEth: 0.35,
  /** Slippage guard on the quoted amountOut (basis points) */
  slippageBps: 300,
  /** Skip dust buys smaller than this */
  minEthPerBuy: 0.0005,
  /**
   * Smart LP (Stonk Exchange vDEX) rails — operator suite grant 2026-09-10.
   * Total capital deployed into LP/staking, in ETH-equivalent (ETH side plus
   * the STONK side valued at pool price at entry).
   */
  maxLpEthEquivTotal: 0.02,
  /** Amount tolerance on LP mint/exit (basis points; matches the site UI's 1%) */
  lpSlippageBps: 100,
  /** Skip LP entries whose ETH side would be under this (dust position) */
  minLpEthSide: 0.001,
} as const;

/** ETH-equivalent already deployed into open LP positions (entry-priced). */
export function lpDeployedEthEquiv(state: SwarmState): number {
  return (state.treasuryLp ?? [])
    .filter((p) => !p.exitedAt)
    .reduce((s, p) => s + p.ethIn * 2, 0); // full-range entry is ~50/50 by value
}

/** True when the LP total cap leaves room for another ETH-equivalent chunk. */
export function lpCapAllows(state: SwarmState, addEthEquiv: number): boolean {
  return lpDeployedEthEquiv(state) + addEthEquiv <= TREASURY_CAPS.maxLpEthEquivTotal + 1e-12;
}

const DAY_MS = 24 * 3600_000;

export interface BuyEligibility {
  eligible: boolean;
  reason: string;
  /** ETH the caps allow for the next buy right now */
  amountEth: number;
  /** ETH spent on buys in the rolling 24h window */
  spent24hEth: number;
  /** Earliest timestamp the next buy can fire (cap-based; 0 = now) */
  nextEligibleAt: number;
}

/** Pure caps math over the buy ledger — no RPC. Balance/floor is checked at send time. */
export function buyEligibility(state: SwarmState, now = Date.now()): BuyEligibility {
  const buys = state.treasuryBuys ?? [];
  const lastBuyAt = buys.reduce((max, b) => Math.max(max, b.ts), 0);
  const gapMs = TREASURY_CAPS.minBuyGapHours * 3600_000;
  const inWindow = buys.filter((b) => b.ts > now - DAY_MS);
  const spent24h = inWindow.reduce((s, b) => s + b.ethIn, 0);

  const gapFreeAt = lastBuyAt ? lastBuyAt + gapMs : 0;
  /* When the 24h spend cap binds, it frees as the oldest buy rolls out of the window. */
  const capBound = spent24h + TREASURY_CAPS.minEthPerBuy > TREASURY_CAPS.maxEthPer24h;
  const oldestInWindow = inWindow.reduce((min, b) => Math.min(min, b.ts), now);
  const capFreeAt = capBound ? oldestInWindow + DAY_MS : 0;
  const nextEligibleAt = Math.max(gapFreeAt, capFreeAt);

  if (now < gapFreeAt) {
    return {
      eligible: false,
      reason: `last buy ${((now - lastBuyAt) / 3600_000).toFixed(1)}h ago — min gap ${TREASURY_CAPS.minBuyGapHours}h`,
      amountEth: 0,
      spent24hEth: spent24h,
      nextEligibleAt,
    };
  }
  const remaining = TREASURY_CAPS.maxEthPer24h - spent24h;
  if (remaining < TREASURY_CAPS.minEthPerBuy) {
    return {
      eligible: false,
      reason: `24h spend ${spent24h.toFixed(4)} ETH leaves under ${TREASURY_CAPS.minEthPerBuy} ETH of the ${TREASURY_CAPS.maxEthPer24h} ETH cap`,
      amountEth: 0,
      spent24hEth: spent24h,
      nextEligibleAt,
    };
  }
  return {
    eligible: true,
    reason: "",
    amountEth: Math.min(TREASURY_CAPS.maxEthPerBuy, remaining),
    spent24hEth: spent24h,
    nextEligibleAt: 0,
  };
}
