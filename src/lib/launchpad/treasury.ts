import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
} from "viem";
import { LAUNCH_CAPS, getAccount } from "@/lib/launchpad/service";
import { ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import { TREASURY_CAPS, buyEligibility } from "@/lib/launchpad/treasury-caps";
import { mintGate } from "@/lib/swarm/tuner";
import { loadState, newId, pushEvent, updateState } from "@/lib/store";
import type { SwarmState, TreasuryBuy } from "@/lib/types";

export { TREASURY_CAPS, buyEligibility } from "@/lib/launchpad/treasury-caps";

/**
 * Treasury operations — the wallet as a mission-influence tool.
 *
 * LAURA accumulates $STONKBROKER (the mission token) with treasury ETH in
 * small, hard-capped periodic buys. This is the one action that pushes the
 * price lever directly instead of through content: real buy-side flow on the
 * token's own DEX liquidity.
 *
 * Venue (verified on-chain 2026-09-10, see library/30-integrations.md):
 * Uniswap v3 on Robinhood Chain. The router below answered factory() =
 * 0x1f7d…2EfA — the SAME factory that deployed the deepest v3
 * STONKBROKER/WETH pool ($881k liquidity, fee tier 10000) — plus WETH9() =
 * the chain's canonical WETH and factoryV2(), i.e. a SwapRouter02. 79 of the
 * last 418 organic swaps on that pool routed through it. The deepest venue
 * overall is a Uniswap v4 native-ETH pool (~$2.8M), but v4 needs Universal
 * Router command encoding; at our buy sizes (≤0.005 ETH) the v3 pools'
 * slippage is negligible, so the simpler, verified v3 path wins. Both live
 * v3 fee tiers are quoted per buy and the better output is taken.
 *
 * CHARTER GUARD: buys are ONLY ever for the mission token. The allowlist is
 * code, not judgment — and any token LAURA launched herself is explicitly
 * refused even if an address ever collided, because buying her own launches
 * would be wash trading (charter rule: never inflate volume artificially).
 */

/** Uniswap v3 swap surface on Robinhood Chain (verified live, 2026-09-10). */
export const STONK_DEX = {
  /** SwapRouter02: factory()/WETH9() verified against the pool + canonical WETH */
  router: "0xCaf681a66D020601342297493863E78C959E5cb2" as `0x${string}`,
  /** Uniswap v3 factory both STONKBROKER/WETH pools belong to */
  factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as `0x${string}`,
  /** Fee tiers with live STONKBROKER/WETH liquidity, deepest first */
  feeTiers: [10_000, 3_000] as const,
} as const;

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

const ROUTER_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
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

function log(msg: string): void {
  console.log(`[treasury ${new Date().toISOString()}] ${msg}`);
}

const DAY_MS = 24 * 3600_000;

/**
 * Charter compliance, enforced in code: the ONLY buyable token is the mission
 * token from settings, and it must not be any token LAURA launched herself
 * (own-token buys would be wash trading, banned by charter).
 */
export function missionTokenGuard(state: SwarmState): { ok: boolean; token: `0x${string}`; reason: string } {
  const token = state.settings.tokenAddress.toLowerCase() as `0x${string}`;
  if (token !== QUOTE_TOKENS.stonk.address.toLowerCase()) {
    return { ok: false, token, reason: `settings.tokenAddress ${token} is not the verified $STONKBROKER address — refusing to buy an unknown token` };
  }
  const ownLaunch = state.launches.find((l) => l.tokenAddress?.toLowerCase() === token);
  if (ownLaunch) {
    return { ok: false, token, reason: `token ${token} is LAURA's own launch $${ownLaunch.symbol} — own-token buys are wash trading and banned by charter` };
  }
  return { ok: true, token: QUOTE_TOKENS.stonk.address, reason: "" };
}

export type BuyResult =
  | { ok: true; sent: true; buy: TreasuryBuy }
  | { ok: true; sent: false; reason: string }
  | { ok: false; reason: string };

/**
 * Executes one capped $STONKBROKER accumulation buy: quotes both live v3 fee
 * tiers via simulateContract, applies the slippage guard, sends through the
 * verified SwapRouter02 with native ETH (the router wraps), and records the
 * buy + a `treasury.buy` event. Every gate fails closed; a `maxEth` override
 * can only shrink the amount, never exceed the caps.
 */
export async function executeTreasuryBuy(opts: { maxEth?: number } = {}): Promise<BuyResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured (SWARM_WALLET_PRIVATE_KEY)" };

  const state = await loadState();
  const guard = missionTokenGuard(state);
  if (!guard.ok) return { ok: false, reason: guard.reason };

  const elig = buyEligibility(state);
  if (!elig.eligible) return { ok: true, sent: false, reason: elig.reason };

  let amountEth = Math.min(elig.amountEth, opts.maxEth ?? TREASURY_CAPS.maxEthPerBuy);
  const balanceWei = await publicClient.getBalance({ address: account.address });
  const balanceEth = Number(formatEther(balanceWei));
  const spendable = balanceEth - TREASURY_CAPS.treasuryFloorEth;
  if (spendable < TREASURY_CAPS.minEthPerBuy) {
    return {
      ok: true,
      sent: false,
      reason: `treasury ${balanceEth.toFixed(4)} ETH is at the ${TREASURY_CAPS.treasuryFloorEth} ETH floor — launches stay funded first`,
    };
  }
  amountEth = Math.min(amountEth, spendable);
  if (amountEth < TREASURY_CAPS.minEthPerBuy) {
    return { ok: true, sent: false, reason: `computed buy ${amountEth.toFixed(5)} ETH is under the ${TREASURY_CAPS.minEthPerBuy} ETH dust threshold` };
  }
  const amountIn = parseEther(amountEth.toFixed(18));

  /* Quote both fee tiers read-only; take the better output. */
  const swapArgs = (fee: number, minOut: bigint) =>
    ({
      tokenIn: QUOTE_TOKENS.weth.address,
      tokenOut: guard.token,
      fee,
      recipient: account.address,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }) as const;

  let bestFee = 0;
  let bestOut = 0n;
  for (const fee of STONK_DEX.feeTiers) {
    try {
      const { result } = await publicClient.simulateContract({
        account,
        address: STONK_DEX.router,
        abi: ROUTER_ABI,
        functionName: "exactInputSingle",
        args: [swapArgs(fee, 0n)],
        value: amountIn,
      });
      if (result > bestOut) {
        bestOut = result;
        bestFee = fee;
      }
    } catch (err) {
      log(`quote on fee tier ${fee} failed (non-fatal): ${String(err).slice(0, 160)}`);
    }
  }
  if (bestOut === 0n) return { ok: false, reason: "every fee-tier quote simulation failed — no viable pool right now" };

  const minOut = (bestOut * BigInt(10_000 - TREASURY_CAPS.slippageBps)) / 10_000n;
  const { request } = await publicClient.simulateContract({
    account,
    address: STONK_DEX.router,
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [swapArgs(bestFee, minOut)],
    value: amountIn,
  });

  const stonkBefore = (await publicClient.readContract({
    address: guard.token,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `swap reverted: ${txHash}` };

  const stonkAfter = (await publicClient.readContract({
    address: guard.token,
    abi: ERC20_BALANCE_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  const tokensOut = Number(formatEther(stonkAfter - stonkBefore));

  const buy: TreasuryBuy = {
    id: newId("tbuy"),
    ts: Date.now(),
    ethIn: amountEth,
    tokensOut,
    txHash,
    feeTier: bestFee,
    router: STONK_DEX.router,
  };
  await updateState((s) => {
    s.treasuryBuys = [...(s.treasuryBuys ?? []), buy];
    pushEvent(s, {
      kind: "treasury.buy",
      agentId: "system",
      title: `Treasury buy: ${amountEth.toFixed(4)} ETH → ${tokensOut.toFixed(2)} $STONKBROKER`,
      detail: `Mission-token accumulation on Uniswap v3 (fee tier ${bestFee / 100 / 100}%) · tx ${txHash} · 24h spend ${(elig.spent24hEth + amountEth).toFixed(4)}/${TREASURY_CAPS.maxEthPer24h} ETH · caps: ≤${TREASURY_CAPS.maxEthPerBuy}/buy, ≥${TREASURY_CAPS.minBuyGapHours}h gap, ${TREASURY_CAPS.treasuryFloorEth} ETH floor`,
      refId: buy.id,
    });
  });
  log(`bought ${tokensOut.toFixed(2)} STONK for ${amountEth} ETH (fee tier ${bestFee}, tx ${txHash})`);
  return { ok: true, sent: true, buy };
}

declare global {
  var __lauraTreasuryOps: { running: boolean; nextAttemptAt: number } | undefined;
}

function opsState() {
  if (!globalThis.__lauraTreasuryOps) {
    globalThis.__lauraTreasuryOps = { running: false, nextAttemptAt: 0 };
  }
  return globalThis.__lauraTreasuryOps;
}

const FAILURE_BACKOFF_MS = 30 * 60_000;

/**
 * Scheduler entry point: executes at most one capped accumulation buy when
 * `settings.autoTreasuryOps` is on and every cap allows it. Skips while the
 * launch executor holds the wallet (a deploy mid-flight must never race a
 * swap for the nonce). Never throws; failures back off 30 minutes.
 */
export async function runTreasuryTick(state: SwarmState): Promise<void> {
  const ops = opsState();
  if (ops.running) return;
  if (!state.settings.autoTreasuryOps) return;
  const now = Date.now();
  if (now < ops.nextAttemptAt) return;
  /* Cheap pure-math pre-check so idle ticks cost nothing. */
  if (!buyEligibility(state, now).eligible) return;
  if (globalThis.__lauraLaunchExecutor?.running) {
    log("deferring buy: launch executor holds the wallet this tick");
    return;
  }
  ops.running = true;
  try {
    const res = await executeTreasuryBuy();
    if (res.ok && res.sent) {
      ops.nextAttemptAt = now + TREASURY_CAPS.minBuyGapHours * 3600_000;
    } else if (res.ok) {
      log(`buy skipped: ${res.reason}`);
    } else {
      ops.nextAttemptAt = now + FAILURE_BACKOFF_MS;
      log(`buy failed (backing off 30m): ${res.reason}`);
    }
  } catch (err) {
    ops.nextAttemptAt = now + FAILURE_BACKOFF_MS;
    log(`buy threw (backing off 30m): ${String(err)}`);
  } finally {
    ops.running = false;
  }
}

/**
 * Compact launch-capacity + treasury line for Mint's prompt, so its
 * skip/propose reasoning is grounded in real capacity instead of guesses.
 */
export function launchCapacityDigest(state: SwarmState, now = Date.now()): string {
  const deployed = state.launches
    .filter((l) => l.status === "deployed" && (l.deployedAt ?? 0) > now - DAY_MS)
    .map((l) => l.deployedAt ?? 0)
    .sort((a, b) => a - b);
  const used = deployed.length;
  const headroomAt = used >= LAUNCH_CAPS.maxDeploysPerDay ? deployed[0] + DAY_MS : 0;
  const gate = mintGate(state);
  const t = state.treasury;
  const buys = state.treasuryBuys ?? [];
  const elig = buyEligibility(state, now);
  const stonkBought = buys.reduce((s, b) => s + b.tokensOut, 0);
  const lines = [
    `- Deploy cap: ${used}/${LAUNCH_CAPS.maxDeploysPerDay} used in the rolling 24h${headroomAt ? ` — next headroom ~${new Date(headroomAt).toISOString().slice(0, 16)}Z` : " — headroom available now"}`,
    `- Speech gate: ${gate.blocked ? gate.reason : "clear — a worthy launch can be proposed"}`,
    `- Treasury: ${t ? `${t.ethBalance.toFixed(4)} ETH + ${t.wethBalance.toFixed(5)} WETH fees` : "no snapshot yet"} (floor ${TREASURY_CAPS.treasuryFloorEth} ETH) · ${stonkBought.toFixed(0)} $STONKBROKER accumulated over ${buys.length} treasury buys · next buy ${elig.eligible ? "eligible now" : elig.nextEligibleAt ? `~${new Date(elig.nextEligibleAt).toISOString().slice(0, 16)}Z` : "blocked"}`,
  ];
  return lines.join("\n");
}
