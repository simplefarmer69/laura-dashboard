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

import { PAD_LANE_KEYS, type PadLane } from "@/lib/launchpad/contracts";

export interface LaneInfo {
  /** Symbol of the quote token the curve trades in. */
  quote: string;
  /** Stock lanes are weekend-gated; crypto lanes never close. */
  kind: "crypto" | "stock";
  /** One-line flavor for the mint prompt's lane menu. */
  vibe: string;
}

export const LANE_INFO: Record<PadLane, LaneInfo> = {
  weth: { quote: "WETH", kind: "crypto", vibe: "the default ETH lane; broadest reach (every launcher user holds ETH) and creator fees arrive as WETH; fits any concept" },
  stonk: { quote: "STONK", kind: "crypto", vibe: "ecosystem-native $STONKBROKER lane; every curve trade IS mission-token volume (the volume grade lever) and creator fees arrive as $STONKBROKER — pick it when the launch serves the mission, ecosystem lore or community themes" },
  usdg: { quote: "USDG", kind: "crypto", vibe: "stable-quoted lane; fits dollar, payroll, savings and irony-about-stability themes" },
  gme: { quote: "GME", kind: "stock", vibe: "GameStop lane; fits meme-stock, diamond-hands, retail-vs-wallstreet lore" },
  nvda: { quote: "NVDA", kind: "stock", vibe: "Nvidia lane; fits AI, GPUs, compute and tech-bubble themes" },
  aapl: { quote: "AAPL", kind: "stock", vibe: "Apple lane; fits consumer tech, design and cult-of-brand themes" },
  spcx: { quote: "SPCX", kind: "stock", vibe: "SpaceX lane; fits rockets, space, mars and moonshot themes" },
  uso: { quote: "USO", kind: "stock", vibe: "oil ETF lane; fits energy, macro and commodity themes" },
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
  if (LANE_INFO[lane].kind !== "stock") return null;
  if (stockLanesOpen(at)) return null;
  return (
    `${LANE_INFO[lane].quote} lane is closed for the weekend: Chainlink equity feeds ` +
    `publish nothing from Friday close to Monday 00:00 UTC, so a launch deployed now ` +
    `could brick mid-curve. It stays queued and deploys when the lane reopens.`
  );
}

/** Lanes that can deploy at `at` (crypto always; stock lanes on weekdays). */
export function availableLanes(at: Date = new Date()): PadLane[] {
  return stockLanesOpen(at) ? [...PAD_LANE_KEYS] : [...CRYPTO_LANES];
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
  if (LANE_INFO[lane].kind === "stock" && !stockLanesOpen(at)) {
    return CRYPTO_LANES[(cycleSeq * 5 + 1) % CRYPTO_LANES.length];
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
    const closed = info.kind === "stock" && !open ? " [CLOSED until Monday 00:15 UTC - do not pick]" : "";
    return `- ${l}: quoted in ${info.quote} (${info.kind}); ${info.vibe}${closed}`;
  });
  const hint = laneRotationHint(cycleSeq, at);
  const history = recent.length ? recent.join(", ") : "none yet";
  return [
    ...lines,
    open
      ? "All lanes are open right now (weekday, equity feeds live)."
      : "Stock lanes are CLOSED for the weekend (Chainlink equity feeds pause Friday 20:00 UTC to Monday 00:15 UTC). Pick weth, stonk or usdg.",
    `Rotation hint for this cycle: ${hint}. Recent launch lanes (newest first): ${history}.`,
    "Pick the lane whose quote token genuinely fits the concept - a GME-lore token belongs on the gme lane, an AI token on nvda, a generic meme on weth. Avoid using the same lane three launches in a row unless the concept demands it.",
  ].join("\n");
}
