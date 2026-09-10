import { createPublicClient, formatEther, http } from "viem";
import { LAUNCHPAD, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import {
  TREASURY_CAPS,
  buyEligibility,
  lpDeployedEthEquiv,
} from "@/lib/launchpad/treasury-caps";
import { launcherGrid } from "@/lib/launchpad/service";
import type { SwarmState } from "@/lib/types";

/**
 * Watcher's raw material: a deterministic on-chain state digest assembled
 * every cycle from (a) state the schedulers already refresh (treasury
 * snapshot, LP values, buy/LP ledgers) and (b) two live reads — the deepest
 * v3 STONK/WETH pool and the launcher floor rows for LAURA's own tokens.
 * Mirrors intelDigest's contract: never throws, every live source settles
 * independently, and a failure degrades to a warning line instead of
 * blanking the whole digest.
 */

/** Deepest v3 STONKBROKER/WETH pool (~$881k, fee tier 10000; see library/30-integrations.md). */
export const DEEP_STONK_POOL = "0x9cd74d5980A4BF60408B9bA2B0F6a3d368EBf594" as `0x${string}`;

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 3, retryDelay: 800 }),
});

/* Canonical Uniswap v3 slot0 (7 outputs — unlike the vDEX's Slipstream 6). */
const V3_POOL_ABI = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const Q96 = 2n ** 96n;

interface FloorRow {
  id: number;
  phase?: string;
  loadedPct?: number;
  live?: { token?: string };
}

/** Live pool read: spot price + real reserves of the deepest STONK/WETH v3 pool. */
async function fetchPoolState(): Promise<{
  stonkPerEth: number;
  wethReserve: number;
  stonkReserve: number;
}> {
  const [slot0, wethBal, stonkBal] = await Promise.all([
    publicClient.readContract({ address: DEEP_STONK_POOL, abi: V3_POOL_ABI, functionName: "slot0" }),
    publicClient.readContract({
      address: QUOTE_TOKENS.weth.address,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [DEEP_STONK_POOL],
    }) as Promise<bigint>,
    publicClient.readContract({
      address: QUOTE_TOKENS.stonk.address,
      abi: ERC20_BALANCE_ABI,
      functionName: "balanceOf",
      args: [DEEP_STONK_POOL],
    }) as Promise<bigint>,
  ]);
  /* token0 = WETH, token1 = STONK (address order): price = token1/token0 = STONK per WETH. */
  const sqrtPriceX96 = slot0[0];
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const stonkPerEth = Number((priceX192 * 10_000_000n) / (Q96 * Q96)) / 10_000_000;
  return {
    stonkPerEth,
    wethReserve: Number(formatEther(wethBal)),
    stonkReserve: Number(formatEther(stonkBal)),
  };
}

/** Floor phase + market stats for LAURA's own deployed launcher tokens. */
async function fetchOwnTokenStats(state: SwarmState): Promise<string[]> {
  const own = state.launches.filter((l) => l.status === "deployed" && l.tokenAddress);
  if (own.length === 0) return ["No LAURA launches deployed yet."];
  const ownByToken = new Map(own.map((l) => [l.tokenAddress!.toLowerCase(), l]));

  const [floorRes, grid] = await Promise.all([
    fetch(LAUNCHPAD.floorApi, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(12_000),
    }).then(async (r) => {
      if (!r.ok) throw new Error(`floor HTTP ${r.status}`);
      return (await r.json()) as { rows?: FloorRow[] };
    }),
    launcherGrid("new", 60).catch(() => []),
  ]);

  const lines: string[] = [];
  for (const [token, launch] of ownByToken) {
    const row = (floorRes.rows ?? []).find((r) => r.live?.token?.toLowerCase() === token);
    const g = grid.find((t) => t.token.toLowerCase() === token);
    const stats = g
      ? `mcap $${Math.round(g.mcapUsd).toLocaleString()}, curve ${g.curvePct.toFixed(1)}%, ${g.holderCount} holders${g.graduated ? ", graduated" : ""}`
      : "not in public grid";
    lines.push(
      `- ${launch.name} ($${launch.symbol}): floor phase ${row?.phase ?? "missing"} · ${stats}`,
    );
  }
  return lines;
}

/**
 * Assembles the full on-chain digest (~2400 chars max). State-derived
 * sections (treasury, caps, LP, earnings) never fail; the two live sources
 * degrade to warnings.
 */
export async function collectOnchainDigest(
  state: SwarmState,
  ethUsd: number | null,
): Promise<{ digest: string; warnings: string[] }> {
  const now = Date.now();
  const warnings: string[] = [];
  const lines: string[] = [];

  /* 1. Treasury wallet (snapshot refreshed ~10 min by the earnings tick). */
  const t = state.treasury;
  if (t) {
    const age = Math.round((now - t.updatedAt) / 60_000);
    lines.push(
      `TREASURY (snapshot ${age}m old): ${t.ethBalance.toFixed(4)} ETH · ${t.wethBalance.toFixed(6)} WETH (creator fees land here) · ${t.stonkBalance.toFixed(2)} $STONKBROKER in wallet. Floor: never below ${TREASURY_CAPS.treasuryFloorEth} ETH.`,
    );
    const launchLines = t.launches
      .map(
        (e) =>
          `$${e.symbol}: earned ${e.earnedQuote.toFixed(6)} ${e.lane === "weth" ? "WETH" : "STONK"} over ${e.tradeCount} trades${e.claimableQuote > 0 ? `, ${e.claimableQuote.toFixed(6)} claimable via flush` : ""}${e.graduated ? ", graduated (earning stopped)" : ""}`,
      )
      .join(" · ");
    lines.push(`CREATOR FEES (lifetime ${t.totalEarnedQuote.toFixed(6)}): ${launchLines || "no deployed launches tracked"}.`);
  } else {
    lines.push("TREASURY: no snapshot yet (earnings tick has not run).");
  }

  /* 2. Buy caps state (pure math over the ledger). */
  const elig = buyEligibility(state, now);
  const buys = state.treasuryBuys ?? [];
  const stonkBought = buys.reduce((s, b) => s + b.tokensOut, 0);
  lines.push(
    `BUY CAPS: ${buys.length} buys lifetime (${stonkBought.toFixed(0)} STONK accumulated) · 24h spend ${elig.spent24hEth.toFixed(4)}/${TREASURY_CAPS.maxEthPer24h} ETH · next buy ${elig.eligible ? `eligible now (up to ${elig.amountEth.toFixed(4)} ETH)` : elig.nextEligibleAt ? `~${new Date(elig.nextEligibleAt).toISOString().slice(0, 16)}Z (${elig.reason})` : elig.reason} · hard caps ${TREASURY_CAPS.maxEthPerBuy}/buy, ${TREASURY_CAPS.maxEthPer24h}/24h, ${TREASURY_CAPS.minBuyGapHours}h gap.`,
  );

  /* 3. Smart LP positions on the vDEX. */
  const openLp = (state.treasuryLp ?? []).filter((p) => !p.exitedAt);
  if (openLp.length > 0) {
    for (const p of openLp) {
      const drift =
        p.currentEthValue !== undefined
          ? ` · now ~${p.currentEthValue.toFixed(4)} ETH + ${(p.currentStonkValue ?? 0).toFixed(0)} STONK (ETH side ${(((p.currentEthValue - p.ethIn) / p.ethIn) * 100).toFixed(1)}% vs entry)`
          : "";
      lines.push(
        `SMART LP #${p.tokenId} (vDEX, full-range STONK/WETH): entered ${p.ethIn.toFixed(4)} ETH + ${p.stonkIn.toFixed(0)} STONK${drift} · ${p.gauge ? `staked in gauge, ${(p.pendingUpRewards ?? 0).toFixed(3)} $UP pending` : "UNSTAKED (earning swap fees only)"} · cap ${lpDeployedEthEquiv(state).toFixed(4)}/${TREASURY_CAPS.maxLpEthEquivTotal} ETH-equiv deployed.`,
      );
    }
  } else {
    lines.push(
      `SMART LP: no open position · cap headroom ${(TREASURY_CAPS.maxLpEthEquivTotal - lpDeployedEthEquiv(state)).toFixed(4)} ETH-equiv.`,
    );
  }

  /* 4 + 5. Live reads: deep pool state, own-token floor stats. */
  const [pool, ownTokens] = await Promise.allSettled([fetchPoolState(), fetchOwnTokenStats(state)]);
  if (pool.status === "fulfilled") {
    const v = pool.value;
    const stonkUsd = ethUsd && v.stonkPerEth > 0 ? ethUsd / v.stonkPerEth : null;
    lines.push(
      `DEEP POOL (v3 STONK/WETH 1%, ${DEEP_STONK_POOL.slice(0, 8)}…): ${v.stonkPerEth.toFixed(0)} STONK per ETH${stonkUsd ? ` (≈$${stonkUsd.toFixed(5)}/STONK at ETH $${ethUsd!.toFixed(0)})` : ""} · reserves ${v.wethReserve.toFixed(2)} WETH + ${(v.stonkReserve / 1e6).toFixed(2)}M STONK.`,
    );
  } else {
    warnings.push(`pool read failed: ${String(pool.reason).slice(0, 120)}`);
  }
  if (ownTokens.status === "fulfilled") {
    lines.push(`LAURA'S OWN TOKENS ON THE FLOOR:\n${ownTokens.value.join("\n")}`);
  } else {
    warnings.push(`floor read failed: ${String(ownTokens.reason).slice(0, 120)}`);
  }
  if (warnings.length > 0) lines.push(`Onchain warnings: ${warnings.join(" · ")}`);

  return { digest: lines.join("\n").slice(0, 2400), warnings };
}
