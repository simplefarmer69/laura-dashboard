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

/**
 * Ecosystem participation caps: Purser buying and selling OTHER builders'
 * curve tokens on the Stonk Launcher (operator grant 2026-09-12: "actively
 * use the funds to participate in the StonkBrokers eco ... buy and sell as
 * she wishes"). Sized so a total wipeout of every open position costs less
 * than one day of the accumulation budget. Own launches and the mission
 * token are refused in code, not left to judgment.
 */
export const ECO_CAPS = {
  /** Max native ETH per single buy */
  maxEthPerTrade: 0.002,
  /** Max ETH spent on eco buys per rolling 24h */
  maxEthPer24h: 0.006,
  /** Distinct tokens held at once */
  maxOpenPositions: 3,
  /** Skip dust trades under this */
  minEthPerTrade: 0.0005,
  /** Curves move fast: tolerance on the simulated output */
  slippageBps: 500,
  /** One trade per token per this many hours (no churning one curve) */
  perTokenGapHours: 2,
} as const;

/**
 * Nightshades caps: Purser trading the four faction tokens of the Meebco x
 * Clutch Markets survival game through the game's own router (operator grant
 * 2026-09-15). The game moves 20-80% of a struck faction's pool liquidity
 * every Night, so every position is sized as a wager the treasury can lose
 * outright: the whole book at once costs about one day of the accumulation
 * budget. Trading is refused in code while a Night is resolving and while the
 * Sunrise anti-snipe tax is above `maxSnipeTaxBps`.
 */
export const NIGHTSHADES_CAPS = {
  /** Max WETH per single buy */
  maxEthPerTrade: 0.003,
  /** Max WETH spent on faction buys per rolling 24h */
  maxEthPer24h: 0.008,
  /** Skip dust trades under this */
  minEthPerTrade: 0.0005,
  /** Tolerance on the quoted output (the hooked pools carry a 1% fee on top) */
  slippageBps: 300,
  /** One trade per faction per this many hours (no churning a pool) */
  perFactionGapHours: 1,
  /** Never trade while the Sunrise anti-snipe tax is above this (it starts at 99%) */
  maxSnipeTaxBps: 100,
} as const;

export interface NightshadesHolding {
  faction: string;
  symbol: string;
  token: string;
  tokens: number;
  ethIn: number;
  ethOut: number;
  lastTs: number;
}

/** Net faction-token balance Purser still holds per faction, from the Nightshades ledger. */
export function nightshadesHoldings(state: SwarmState): Map<string, NightshadesHolding> {
  const out = new Map<string, NightshadesHolding>();
  for (const t of state.treasuryNightshadesTrades ?? []) {
    const h = out.get(t.faction) ?? { faction: t.faction, symbol: t.symbol, token: t.token.toLowerCase(), tokens: 0, ethIn: 0, ethOut: 0, lastTs: 0 };
    if (t.side === "buy") {
      h.tokens += t.tokenAmount;
      h.ethIn += t.ethAmount;
    } else {
      h.tokens -= t.tokenAmount;
      h.ethOut += t.ethAmount;
    }
    h.lastTs = Math.max(h.lastTs, t.ts);
    out.set(t.faction, h);
  }
  return out;
}

/** Factions with a positive remaining balance (dust below 1e-9 counts as closed). */
export function openNightshadesPositions(state: SwarmState): NightshadesHolding[] {
  return [...nightshadesHoldings(state).values()].filter((h) => h.tokens > 1e-9);
}

export interface NightshadesEligibility {
  eligible: boolean;
  reason: string;
  /** WETH the caps allow for the next buy right now */
  amountEth: number;
  spent24hEth: number;
}

/** Pure caps math over the Nightshades ledger for a prospective trade on `faction` (the Night/Sunrise guards are read on-chain at send time). */
export function nightshadesEligibility(state: SwarmState, faction: string, side: "buy" | "sell", now = Date.now()): NightshadesEligibility {
  const trades = state.treasuryNightshadesTrades ?? [];
  const spent24h = trades.filter((t) => t.side === "buy" && t.ts > now - DAY_MS).reduce((s, t) => s + t.ethAmount, 0);
  const lastOnFaction = trades.filter((t) => t.faction === faction).reduce((m, t) => Math.max(m, t.ts), 0);
  if (lastOnFaction && now - lastOnFaction < NIGHTSHADES_CAPS.perFactionGapHours * 3600_000) {
    return { eligible: false, reason: `last trade on ${faction} ${((now - lastOnFaction) / 60_000).toFixed(0)}m ago; min gap ${NIGHTSHADES_CAPS.perFactionGapHours}h`, amountEth: 0, spent24hEth: spent24h };
  }
  if (side === "sell") return { eligible: true, reason: "", amountEth: 0, spent24hEth: spent24h };
  const remaining = NIGHTSHADES_CAPS.maxEthPer24h - spent24h;
  if (remaining < NIGHTSHADES_CAPS.minEthPerTrade) {
    return { eligible: false, reason: `Nightshades 24h spend ${spent24h.toFixed(4)} WETH leaves under ${NIGHTSHADES_CAPS.minEthPerTrade} of the ${NIGHTSHADES_CAPS.maxEthPer24h} WETH cap`, amountEth: 0, spent24hEth: spent24h };
  }
  return { eligible: true, reason: "", amountEth: Math.min(NIGHTSHADES_CAPS.maxEthPerTrade, remaining), spent24hEth: spent24h };
}

/** Net token balance Purser still holds per token address, from the eco ledger. */
export function ecoHoldings(state: SwarmState): Map<string, { symbol: string; launchId: number; tokens: number; ethIn: number; ethOut: number; lastTs: number }> {
  const out = new Map<string, { symbol: string; launchId: number; tokens: number; ethIn: number; ethOut: number; lastTs: number }>();
  for (const t of state.treasuryEcoTrades ?? []) {
    const key = t.token.toLowerCase();
    const h = out.get(key) ?? { symbol: t.symbol, launchId: t.launchId, tokens: 0, ethIn: 0, ethOut: 0, lastTs: 0 };
    if (t.side === "buy") {
      h.tokens += t.tokenAmount;
      h.ethIn += t.ethAmount;
    } else {
      h.tokens -= t.tokenAmount;
      h.ethOut += t.ethAmount;
    }
    h.lastTs = Math.max(h.lastTs, t.ts);
    out.set(key, h);
  }
  return out;
}

/** Tokens with a positive remaining balance (dust below 1e-9 counts as closed). */
export function openEcoPositions(state: SwarmState): Array<{ token: string; symbol: string; launchId: number; tokens: number; ethIn: number; ethOut: number; lastTs: number }> {
  return [...ecoHoldings(state).entries()]
    .filter(([, h]) => h.tokens > 1e-9)
    .map(([token, h]) => ({ token, ...h }));
}

export interface EcoBuyEligibility {
  eligible: boolean;
  reason: string;
  /** ETH the caps allow for the next buy right now */
  amountEth: number;
  spent24hEth: number;
}

/** Pure caps math over the eco ledger for a prospective buy of `token`. */
export function ecoBuyEligibility(state: SwarmState, token: string, now = Date.now()): EcoBuyEligibility {
  const trades = state.treasuryEcoTrades ?? [];
  const key = token.toLowerCase();
  const spent24h = trades.filter((t) => t.side === "buy" && t.ts > now - DAY_MS).reduce((s, t) => s + t.ethAmount, 0);
  const remaining = ECO_CAPS.maxEthPer24h - spent24h;
  if (remaining < ECO_CAPS.minEthPerTrade) {
    return { eligible: false, reason: `eco 24h spend ${spent24h.toFixed(4)} ETH leaves under ${ECO_CAPS.minEthPerTrade} of the ${ECO_CAPS.maxEthPer24h} ETH cap`, amountEth: 0, spent24hEth: spent24h };
  }
  const lastOnToken = trades.filter((t) => t.token.toLowerCase() === key).reduce((m, t) => Math.max(m, t.ts), 0);
  if (lastOnToken && now - lastOnToken < ECO_CAPS.perTokenGapHours * 3600_000) {
    return { eligible: false, reason: `last trade on this token ${((now - lastOnToken) / 3600_000).toFixed(1)}h ago; min gap ${ECO_CAPS.perTokenGapHours}h`, amountEth: 0, spent24hEth: spent24h };
  }
  const open = openEcoPositions(state);
  if (!open.some((p) => p.token === key) && open.length >= ECO_CAPS.maxOpenPositions) {
    return { eligible: false, reason: `${open.length} eco positions open (max ${ECO_CAPS.maxOpenPositions}); sell one before buying another token`, amountEth: 0, spent24hEth: spent24h };
  }
  return { eligible: true, reason: "", amountEth: Math.min(ECO_CAPS.maxEthPerTrade, remaining), spent24hEth: spent24h };
}

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
