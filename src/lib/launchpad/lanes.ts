/**
 * Quote-lane selection for Smart Launch V2 deploys.
 *
 * Every pad in LAUNCHPAD.pads is a StonkSafeLaunchpadV2 singleton whose
 * bonding curve runs IN that quote token. Crypto-quoted lanes (WETH, STONK,
 * USDG) work around the clock. Stock-quoted lanes (GME, NVDA, AAPL, SPCX,
 * USO) depend on Chainlink equity feeds classed us_equities_24/5: the feeds
 * publish nothing from Friday market close until Monday 00:00 UTC, and the
 * pad's price checks go stale after 48h. A launch deployed into that window
 * can brick mid-curve (buys revert on StalePrice) even though the deploy tx
 * itself lands, so we refuse stock lanes across the whole weekend window
 * rather than strand a 95-minute launch.
 *
 * Window is deliberately conservative: closed from Friday 20:00 UTC (last
 * reliable feed updates land around US market close) through Monday
 * 00:15 UTC (a small margin past the feeds' Monday 00:00 UTC resume).
 */

import { PAD_LANE_KEYS, laneChain, laneChainKey, type PadLane } from "@/lib/launchpad/contracts";

export interface LaneInfo {
  /** Symbol of the quote token the curve trades in. */
  quote: string;
  /** Stock lanes are weekend-gated; crypto lanes never close. */
  kind: "crypto" | "stock";
  /** One-line flavor for the mint prompt's lane menu. */
  vibe: string;
}

/**
 * Whether the swarm wallet can pay gas on each foreign launch chain right now.
 * Refreshed by the executor / cycle context from service.laneFundingProblem
 * (an async chain read) so the synchronous lane menu, rotation and resolver
 * can steer Mint away from a lane whose chain is unfunded. Default true so
 * a missed refresh never hides a funded lane; the executor's own pre-deploy
 * funding check is the hard gate.
 */
const foreignChainFunded: Record<string, boolean> = { arbitrum: true };
export function setChainFunded(chain: string, funded: boolean): void {
  foreignChainFunded[chain] = funded;
}
export function laneChainFunded(lane: PadLane): boolean {
  const key = laneChainKey(lane);
  if (key === "robinhood") return true;
  return foreignChainFunded[key] ?? true;
}

export const LANE_INFO: Record<PadLane, LaneInfo> = {
  weth: { quote: "WETH", kind: "crypto", vibe: "the default ETH lane; broadest reach (every launcher user holds ETH) and creator fees arrive as WETH; fits any concept" },
  stonk: { quote: "STONK", kind: "crypto", vibe: "ecosystem-native $STONKBROKER lane; every curve trade IS mission-token volume (the volume grade lever) and creator fees arrive as $STONKBROKER — pick it when the launch serves the mission, ecosystem lore or community themes" },
  usdg: { quote: "USDG", kind: "crypto", vibe: "stable-quoted lane; fits dollar, payroll, savings and irony-about-stability themes" },
  gme: { quote: "GME", kind: "stock", vibe: "GameStop lane — the quote asset IS the tokenized GME stock, so the launch trades against GME natively and creator fees accrue IN GME; the strongest possible frame for meme-stock, diamond-hands and retail-vs-wallstreet lore (LAURA inside the meme-stock story, not commenting on it)" },
  nvda: { quote: "NVDA", kind: "stock", vibe: "Nvidia lane — quote is tokenized NVDA stock and fees accrue in NVDA; the native home for AI, GPU, compute and tech-bubble angles" },
  aapl: { quote: "AAPL", kind: "stock", vibe: "Apple lane — quote is tokenized AAPL stock and fees accrue in AAPL; fits consumer tech, design and cult-of-brand themes" },
  spcx: { quote: "SPCX", kind: "stock", vibe: "SpaceX lane — quote is tokenized SPCX stock and fees accrue in SPCX; fits rockets, space, mars and moonshot themes" },
  uso: { quote: "USO", kind: "stock", vibe: "oil ETF lane — quote is tokenized USO and fees accrue in USO; fits energy, macro and commodity themes" },
  arbweth: {
    quote: "WETH",
    kind: "crypto",
    vibe: "ARBITRUM ONE ETH lane (chain 42161, operator directive 2026-09-15) — the StonkBrokers launcher's second chain, the L2 Robinhood Chain settles to; a launch here is the same V2 pad flow, buyers pay native ETH on Arbitrum, bonded pools go to Uniswap v3 (1%), and it puts the StonkBrokers launcher in front of Arbitrum's much larger DeFi crowd; fits concepts about Arbitrum itself, cross-chain arrival, L2 culture, DeFi-native humor, or anything meant to pull Arbitrum users toward Robinhood Chain and $STONKBROKER; creator fees arrive as Arbitrum WETH",
  },
};

export const CRYPTO_LANES = PAD_LANE_KEYS.filter((l) => LANE_INFO[l].kind === "crypto");
export const STOCK_LANES = PAD_LANE_KEYS.filter((l) => LANE_INFO[l].kind === "stock");

/** True while Chainlink equity feeds are live (see module comment). */
export function stockLanesOpen(at: Date = new Date()): boolean {
  const day = at.getUTCDay();
  const hour = at.getUTCHours();
  const min = at.getUTCMinutes();
  if (day === 6 || day === 0) return false; // Saturday, Sunday
  if (day === 5 && hour >= 20) return false; // Friday from 20:00 UTC
  if (day === 1 && hour === 0 && min < 15) return false; // Monday until 00:15 UTC
  return true;
}

/**
 * Null when the lane can deploy right now; otherwise a plain-language reason.
 * Used both by the executor's autonomous queue and the operator deploy API,
 * so a weekend stock-lane deploy is blocked with words instead of an opaque
 * on-chain revert.
 */
export function laneClosedReason(lane: PadLane, at: Date = new Date()): string | null {
  if (!laneChainFunded(lane)) {
    return `${laneChain(lane).label} wallet is unfunded (below the gas floor); bridge ETH there before the ${lane} lane can deploy. The launch stays queued.`;
  }
  if (LANE_INFO[lane].kind !== "stock") return null;
  if (stockLanesOpen(at)) return null;
  return (
    `${LANE_INFO[lane].quote} lane is closed for the weekend: Chainlink equity feeds ` +
    `publish nothing from Friday close to Monday 00:00 UTC, so a launch deployed now ` +
    `could brick mid-curve. It stays queued and deploys when the lane reopens.`
  );
}

/** Lanes that can deploy at `at` (crypto always; stock lanes on weekdays; foreign chains only when funded). */
export function availableLanes(at: Date = new Date()): PadLane[] {
  const base = stockLanesOpen(at) ? [...PAD_LANE_KEYS] : [...CRYPTO_LANES];
  return base.filter((l) => laneChainFunded(l));
}

/**
 * Rotation hint for the mint prompt - same shape as the per-cycle lane
 * rotation in swarm/context.ts laneAssignment (seed walks a wheel each
 * cycle). It is only a HINT: the model picks the lane that fits the
 * concept, the hint just nudges variety across cycles.
 */
export function laneRotationHint(cycleSeq: number, at: Date = new Date()): PadLane {
  const lanes = availableLanes(at);
  return lanes[(cycleSeq * 5 + 1) % lanes.length];
}

/**
 * Validate the model's lane pick against what can actually deploy. Unknown
 * lane falls back to the rotation hint; a stock lane picked on a weekend
 * falls back to a crypto lane (rotated) so the launch is never stranded on
 * an approval it cannot execute for days.
 */
export function resolveLane(
  requested: string | null | undefined,
  at: Date = new Date(),
  cycleSeq = 0,
): PadLane {
  const lane = PAD_LANE_KEYS.find((l) => l === requested);
  if (!lane) return laneRotationHint(cycleSeq, at);
  /* A funded-chain fallback keeps the launch deployable today instead of
     stranding it on an unfunded chain; weth is the Robinhood default lane. */
  if (!laneChainFunded(lane)) return "weth";
  if (LANE_INFO[lane].kind === "stock" && !stockLanesOpen(at)) {
    const open = CRYPTO_LANES.filter((l) => laneChainFunded(l));
    return open[(cycleSeq * 5 + 1) % open.length];
  }
  return lane;
}

/** Lanes of the most recent non-rejected launches, newest first. */
export function recentLaunchLanes(
  launches: Array<{ lane: PadLane; status: string; createdAt: number }>,
  limit = 6,
): PadLane[] {
  return launches
    .filter((l) => l.status !== "rejected" && l.status !== "failed")
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit)
    .map((l) => l.lane);
}

/**
 * The LANE MENU text block the mint prompt receives: every lane with its
 * quote token and flavor, weekend availability, the rotation hint, and the
 * recent lane history so the model spreads launches across lanes.
 */
export function laneMenuDigest(
  at: Date,
  cycleSeq: number,
  recent: PadLane[],
): string {
  const open = stockLanesOpen(at);
  const lines = PAD_LANE_KEYS.map((l) => {
    const info = LANE_INFO[l];
    const closed = info.kind === "stock" && !open ? " [CLOSED at this spec's deploy slot (weekend) - do not pick]" : "";
    const unfunded = laneChainFunded(l) ? "" : ` [UNFUNDED: the ${laneChain(l).label} wallet is below its gas floor - do not pick until Purser bridges ETH there]`;
    const chain = laneChainKey(l) === "robinhood" ? "" : ` on ${laneChain(l).label}`;
    return `- ${l}: quoted in ${info.quote} (${info.kind}${chain}); ${info.vibe}${closed}${unfunded}`;
  });
  const hint = laneRotationHint(cycleSeq, at);
  const history = recent.length ? recent.join(", ") : "none yet";
  return [
    ...lines,
    open
      ? "All lanes are open right now (weekday, equity feeds live). Stock lanes are first-class, verified deployable surfaces (identical pad bounds to weth, createLaunch simulates clean on every stock pad — see the integrations library doc), not exotic options: pairing a launch against a tokenized stock puts LAURA natively inside that stock's story and accrues her fees in it."
      : `Stock lanes are CLOSED at the slot this spec would deploy in (~${at.toISOString().slice(0, 16)}Z, after the queue ahead of it; Chainlink equity feeds pause Friday 20:00 UTC to Monday 00:15 UTC). Pick weth, stonk or usdg, or the spec waits until Monday.`,
    `Rotation hint for this cycle: ${hint}. Recent launch lanes (newest first): ${history}.`,
    "Pick the lane whose quote token genuinely fits the concept - a GME-lore token belongs on the gme lane, an AI token on nvda, a generic meme on weth. Avoid using the same lane three launches in a row unless the concept demands it.",
    "Every lane except arbweth deploys on Robinhood Chain (4663). arbweth deploys on Arbitrum One (42161): pick it when the concept is about Arbitrum, cross-chain reach or pulling Arbitrum's DeFi crowd toward the StonkBrokers launcher — and keep roughly one launch in four there while it is funded, so LAURA is a visible builder on both chains. When you pick arbweth, set bondVenue to 1 (Uniswap v3) — Arbitrum has no StonkUp CL locker and bondVenue 0 reverts.",
  ].join("\n");
}
