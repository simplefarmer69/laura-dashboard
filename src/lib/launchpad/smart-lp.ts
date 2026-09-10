import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http,
  parseEventLogs,
} from "viem";
import { getAccount } from "@/lib/launchpad/service";
import { ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import { TREASURY_CAPS, lpCapAllows, lpDeployedEthEquiv } from "@/lib/launchpad/treasury-caps";
import { missionTokenGuard } from "@/lib/launchpad/treasury";
import { loadState, newId, pushEvent, updateState } from "@/lib/store";
import type { SwarmState, TreasuryLpPosition } from "@/lib/types";

/**
 * Smart LP — the Stonk Exchange (vDEX, "powered by up.") as a treasury tool.
 * Operator grant 2026-09-10 (library/10-operator.md): LAURA may "trade on
 * chain and freely use the StonkBrokers Smart LP and everything else in our
 * product suite."
 *
 * What this module does: mints ONE small full-range STONKBROKER/WETH
 * concentrated-liquidity position on the protocol's own vDEX and stakes the
 * position NFT in its gauge for $UP emissions. Mission value: (a) deepens the
 * mission token's liquidity on the venue the protocol controls (the venue
 * split problem the researcher documented: ~27-34x more STONK volume flows
 * through venues the protocol does NOT control), (b) counts toward protocol
 * TVL, (c) visible on-chain alignment from LAURA's public wallet.
 *
 * Contracts (reverse-engineered from the stonkbrokers.cash /exchange bundle
 * 2026-09-10, then verified on-chain — see library/30-integrations.md):
 * a Velodrome-Slipstream-style CL deployment. The NonfungiblePositionManager's
 * factory() matches the clFactory that deployed the live STONKBROKER/WETH
 * pool, its WETH9() is the chain's canonical WETH, and voter.gauges(pool)
 * resolves a live gauge with active $UP emissions (rewardRate > 0).
 *
 * EXIT PATH (verified before entering, all permissionless, no lockups):
 * gauge.withdraw(tokenId) → positionManager.decreaseLiquidity → collect.
 * The votingEscrow (veUP lock) is deliberately NOT used — lockups trap
 * treasury. Full-range is chosen so the position never goes out of range and
 * needs no tick management.
 */

export const VDEX = {
  /** CL factory of the live up. pools (pool.factory() verified) */
  clFactory: "0x1ac9dB4a2608ba45D6127B1737949b51Bb54B7F3" as `0x${string}`,
  /** NonfungiblePositionManager (factory()/WETH9() verified on-chain) */
  positionManager: "0x07F44c47743A2f36414A82b9F558ECFCf0EEdCEf" as `0x${string}`,
  /** Voter — gauges(pool) resolves the staking gauge */
  voter: "0x7F749fDD351C1Ceed82d76d7699CB631Eb8332a7" as `0x${string}`,
  /** The live STONKBROKER/WETH CL pool (token0 WETH, token1 STONK, tickSpacing 200) */
  stonkWethPool: "0xB11ba9a4d345434c25d625C076f23Ad14abC6B3c" as `0x${string}`,
  /** $UP — the vDEX emissions token gauges pay */
  upToken: "0x57C0E45cB534413D1C20A4240955d6bB250BB4F1" as `0x${string}`,
  tickSpacing: 200,
} as const;

/* Full-range bounds for tickSpacing 200 (±887272 rounded inward). */
const FULL_RANGE_TICK = 887200;

const Q96 = 2n ** 96n;

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

/* Slipstream-style NPM: mint params carry tickSpacing (not fee) and an
   optional sqrtPriceX96 (0 when the pool already exists) — shape taken from
   the site bundle's own mint call. */
const NPM_ABI = [
  {
    type: "function",
    name: "mint",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "tickSpacing", type: "int24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "sqrtPriceX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  { type: "function", name: "refundETH", stateMutability: "payable", inputs: [], outputs: [] },
  {
    type: "function",
    name: "multicall",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getApproved",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "positions",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "tickSpacing", type: "int24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "decreaseLiquidity",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "collect",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "tokenId", type: "uint256", indexed: true },
    ],
  },
] as const;

const GAUGE_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  { type: "function", name: "getReward", stateMutability: "nonpayable", inputs: [{ name: "tokenId", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "earned",
    stateMutability: "view",
    inputs: [
      { name: "account", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const VOTER_ABI = [
  {
    type: "function",
    name: "gauges",
    stateMutability: "view",
    inputs: [{ name: "pool", type: "address" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const POOL_ABI = [
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
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

function log(msg: string): void {
  console.log(`[smart-lp ${new Date().toISOString()}] ${msg}`);
}

function walletClient(account: NonNullable<ReturnType<typeof getAccount>>) {
  return createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
}

export type LpResult =
  | { ok: true; sent: true; position: TreasuryLpPosition }
  | { ok: true; sent: false; reason: string }
  | { ok: false; reason: string };

/**
 * Mints one full-range STONKBROKER/WETH position on the vDEX, pairing the
 * wallet's existing $STONKBROKER (accumulated by treasury buys — no selling
 * needed) with a matched slice of ETH, then stakes the NFT in the gauge.
 * Fails closed on every cap; simulate-first on every send.
 */
export async function enterLpPosition(): Promise<LpResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };

  const state = await loadState();
  if ((state.treasuryLp ?? []).some((p) => !p.exitedAt)) {
    return { ok: true, sent: false, reason: "an open LP position already exists — one position keeps the treasury simple" };
  }
  const guard = missionTokenGuard(state);
  if (!guard.ok) return { ok: false, reason: guard.reason };

  const weth = QUOTE_TOKENS.weth.address;
  const stonk = guard.token;

  const [stonkBal, ethBalWei, slot0] = await Promise.all([
    publicClient.readContract({ address: stonk, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] }) as Promise<bigint>,
    publicClient.getBalance({ address: account.address }),
    publicClient.readContract({ address: VDEX.stonkWethPool, abi: POOL_ABI, functionName: "slot0" }),
  ]);
  const sqrtPriceX96 = slot0[0];

  /* Matched full-range amounts: amount0(WETH) = amount1(STONK) / price,
     price = (sqrtPriceX96/2^96)^2 in token1-per-token0. */
  const stonkIn = stonkBal; // pair everything accumulated so far
  const ethMatchedWei = (stonkIn * Q96 * Q96) / (sqrtPriceX96 * sqrtPriceX96);
  const ethIn = Number(formatEther(ethMatchedWei));

  if (ethIn < TREASURY_CAPS.minLpEthSide) {
    return { ok: true, sent: false, reason: `matched ETH side ${ethIn.toFixed(5)} is under the ${TREASURY_CAPS.minLpEthSide} ETH dust floor — accumulate more STONK first` };
  }
  const ethEquiv = ethIn * 2;
  if (!lpCapAllows(state, ethEquiv)) {
    return {
      ok: true,
      sent: false,
      reason: `LP cap: ${lpDeployedEthEquiv(state).toFixed(4)} deployed + ${ethEquiv.toFixed(4)} new > ${TREASURY_CAPS.maxLpEthEquivTotal} ETH-equiv max`,
    };
  }
  const ethBal = Number(formatEther(ethBalWei));
  if (ethBal - ethIn < TREASURY_CAPS.treasuryFloorEth) {
    return { ok: true, sent: false, reason: `entry would breach the ${TREASURY_CAPS.treasuryFloorEth} ETH treasury floor (balance ${ethBal.toFixed(4)})` };
  }

  const wallet = walletClient(account);

  /* STONK allowance for the position manager. */
  const allowance = (await publicClient.readContract({
    address: stonk,
    abi: ERC20_ABI,
    functionName: "allowance",
    args: [account.address, VDEX.positionManager],
  })) as bigint;
  if (allowance < stonkIn) {
    const { request } = await publicClient.simulateContract({
      account,
      address: stonk,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [VDEX.positionManager, stonkIn],
    });
    const approveTx = await wallet.writeContract(request);
    const rc = await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
    if (rc.status !== "success") return { ok: false, reason: `STONK approve reverted: ${approveTx}` };
  }

  const tol = BigInt(10_000 - TREASURY_CAPS.lpSlippageBps);
  const mintParams = {
    token0: weth,
    token1: stonk,
    tickSpacing: VDEX.tickSpacing,
    tickLower: -FULL_RANGE_TICK,
    tickUpper: FULL_RANGE_TICK,
    amount0Desired: ethMatchedWei,
    amount1Desired: stonkIn,
    amount0Min: (ethMatchedWei * tol) / 10_000n,
    amount1Min: (stonkIn * tol) / 10_000n,
    recipient: account.address,
    deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
    sqrtPriceX96: 0n,
  } as const;

  /* Site-verified pattern: multicall([mint, refundETH]) with native value —
     the manager wraps the ETH side and refunds the unmatched remainder. */
  const calls = [
    encodeFunctionData({ abi: NPM_ABI, functionName: "mint", args: [mintParams] }),
    encodeFunctionData({ abi: NPM_ABI, functionName: "refundETH", args: [] }),
  ];
  const { request } = await publicClient.simulateContract({
    account,
    address: VDEX.positionManager,
    abi: NPM_ABI,
    functionName: "multicall",
    args: [calls],
    value: ethMatchedWei,
  });
  const mintTx = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: mintTx, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `LP mint reverted: ${mintTx}` };

  /* The NFT mint is the ERC-721 Transfer from 0x0 to the wallet. */
  const transfers = parseEventLogs({ abi: NPM_ABI, logs: receipt.logs, eventName: "Transfer" });
  const minted = transfers.find(
    (t) => t.address.toLowerCase() === VDEX.positionManager.toLowerCase() && t.args.to?.toLowerCase() === account.address.toLowerCase(),
  );
  if (!minted?.args.tokenId) return { ok: false, reason: `mint succeeded but no position NFT found in receipt: ${mintTx}` };
  const tokenId = minted.args.tokenId;

  const pos = await publicClient.readContract({
    address: VDEX.positionManager,
    abi: NPM_ABI,
    functionName: "positions",
    args: [tokenId],
  });

  const position: TreasuryLpPosition = {
    id: newId("tlp"),
    ts: Date.now(),
    tokenId: tokenId.toString(),
    pool: VDEX.stonkWethPool,
    ethIn,
    stonkIn: Number(formatEther(stonkIn)),
    liquidity: pos[7].toString(),
    mintTxHash: mintTx,
    gauge: null,
    stakeTxHash: null,
  };
  await updateState((s) => {
    s.treasuryLp = [...(s.treasuryLp ?? []), position];
    pushEvent(s, {
      kind: "treasury.lp",
      agentId: "system",
      title: `Smart LP entered: ${position.ethIn.toFixed(4)} ETH + ${position.stonkIn.toFixed(2)} $STONKBROKER full-range on the Stonk Exchange vDEX`,
      detail: `Mission rationale: deepen $STONKBROKER liquidity on the protocol's OWN venue (venue-split gap: most STONK volume flows through pools the protocol doesn't control) and add protocol TVL, visibly from LAURA's wallet. Position NFT #${position.tokenId} · tx ${mintTx} · exit path verified (gauge.withdraw → decreaseLiquidity → collect, no lockups) · cap ${TREASURY_CAPS.maxLpEthEquivTotal} ETH-equiv total`,
      refId: position.id,
    });
  });
  log(`minted position #${position.tokenId} (${position.ethIn.toFixed(4)} ETH + ${position.stonkIn.toFixed(2)} STONK, tx ${mintTx})`);
  return { ok: true, sent: true, position };
}

/** Stakes an unstaked treasury LP NFT in the pool's gauge for $UP emissions. */
export async function stakeLpPosition(positionId: string): Promise<LpResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const state = await loadState();
  const position = (state.treasuryLp ?? []).find((p) => p.id === positionId);
  if (!position || position.exitedAt) return { ok: false, reason: "No open position with that id" };
  if (position.gauge) return { ok: true, sent: false, reason: "already staked" };

  const gauge = (await publicClient.readContract({
    address: VDEX.voter,
    abi: VOTER_ABI,
    functionName: "gauges",
    args: [position.pool as `0x${string}`],
  })) as `0x${string}`;
  if (!gauge || gauge === "0x0000000000000000000000000000000000000000") {
    return { ok: true, sent: false, reason: "pool has no gauge — position stays unstaked, earning swap fees directly" };
  }

  const wallet = walletClient(account);
  const tokenId = BigInt(position.tokenId);

  const approved = (await publicClient.readContract({
    address: VDEX.positionManager,
    abi: NPM_ABI,
    functionName: "getApproved",
    args: [tokenId],
  })) as string;
  if (approved.toLowerCase() !== gauge.toLowerCase()) {
    const { request } = await publicClient.simulateContract({
      account,
      address: VDEX.positionManager,
      abi: NPM_ABI,
      functionName: "approve",
      args: [gauge, tokenId],
    });
    const approveTx = await wallet.writeContract(request);
    const rc = await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
    if (rc.status !== "success") return { ok: false, reason: `NFT approve reverted: ${approveTx}` };
  }

  const { request } = await publicClient.simulateContract({
    account,
    address: gauge,
    abi: GAUGE_ABI,
    functionName: "deposit",
    args: [tokenId],
  });
  const stakeTx = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: stakeTx, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `gauge deposit reverted: ${stakeTx}` };

  const updated = await updateState((s) => {
    const p = (s.treasuryLp ?? []).find((x) => x.id === positionId);
    if (!p) return null;
    p.gauge = gauge;
    p.stakeTxHash = stakeTx;
    pushEvent(s, {
      kind: "treasury.stake",
      agentId: "system",
      title: `Staked LP position #${p.tokenId} in the vDEX gauge — earning $UP emissions`,
      detail: `Mission rationale: staked liquidity supports the Stonk Exchange's gauge system and pays the treasury in $UP while the position works. Gauge ${gauge} · tx ${stakeTx} · exit stays one call away (gauge.withdraw, no lockup)`,
      refId: p.id,
    });
    return p;
  });
  if (!updated) return { ok: false, reason: "position vanished during stake" };
  log(`staked position #${position.tokenId} in gauge ${gauge} (tx ${stakeTx})`);
  return { ok: true, sent: true, position: updated };
}

/**
 * Full exit: unstake from the gauge (if staked), remove all liquidity, and
 * collect everything back to the wallet. The verified escape hatch — callable
 * any time, no lockups anywhere on the path.
 */
export async function exitLpPosition(positionId: string): Promise<LpResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const state = await loadState();
  const position = (state.treasuryLp ?? []).find((p) => p.id === positionId);
  if (!position || position.exitedAt) return { ok: false, reason: "No open position with that id" };

  const wallet = walletClient(account);
  const tokenId = BigInt(position.tokenId);

  if (position.gauge) {
    const { request } = await publicClient.simulateContract({
      account,
      address: position.gauge as `0x${string}`,
      abi: GAUGE_ABI,
      functionName: "withdraw",
      args: [tokenId],
    });
    const tx = await wallet.writeContract(request);
    const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    if (rc.status !== "success") return { ok: false, reason: `gauge withdraw reverted: ${tx}` };
  }

  const pos = await publicClient.readContract({
    address: VDEX.positionManager,
    abi: NPM_ABI,
    functionName: "positions",
    args: [tokenId],
  });
  const liquidity = pos[7];
  if (liquidity > 0n) {
    const { request } = await publicClient.simulateContract({
      account,
      address: VDEX.positionManager,
      abi: NPM_ABI,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId,
          liquidity,
          amount0Min: 0n, // collect below returns whatever the pool owes; exit must never brick on price moves
          amount1Min: 0n,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
        },
      ],
    });
    const tx = await wallet.writeContract(request);
    const rc = await publicClient.waitForTransactionReceipt({ hash: tx, timeout: 120_000 });
    if (rc.status !== "success") return { ok: false, reason: `decreaseLiquidity reverted: ${tx}` };
  }

  const MAX_U128 = 2n ** 128n - 1n;
  const { request } = await publicClient.simulateContract({
    account,
    address: VDEX.positionManager,
    abi: NPM_ABI,
    functionName: "collect",
    args: [{ tokenId, recipient: account.address, amount0Max: MAX_U128, amount1Max: MAX_U128 }],
  });
  const collectTx = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: collectTx, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `collect reverted: ${collectTx}` };

  const updated = await updateState((s) => {
    const p = (s.treasuryLp ?? []).find((x) => x.id === positionId);
    if (!p) return null;
    p.exitedAt = Date.now();
    p.exitTxHash = collectTx;
    pushEvent(s, {
      kind: "treasury.exit",
      agentId: "system",
      title: `Exited LP position #${p.tokenId} — funds back in the treasury wallet`,
      detail: `Unstaked, removed all liquidity and collected to the wallet · final tx ${collectTx}`,
      refId: p.id,
    });
    return p;
  });
  if (!updated) return { ok: false, reason: "position vanished during exit" };
  log(`exited position #${position.tokenId} (tx ${collectTx})`);
  return { ok: true, sent: true, position: updated };
}

/** Refreshes live value + pending $UP for open positions (read-only). */
export async function refreshLpValues(state: SwarmState): Promise<void> {
  const account = getAccount();
  const open = (state.treasuryLp ?? []).filter((p) => !p.exitedAt);
  if (!account || open.length === 0) return;
  const slot0 = await publicClient.readContract({
    address: VDEX.stonkWethPool,
    abi: POOL_ABI,
    functionName: "slot0",
  });
  const sqrtPriceX96 = slot0[0];
  for (const p of open) {
    try {
      const pos = await publicClient.readContract({
        address: VDEX.positionManager,
        abi: NPM_ABI,
        functionName: "positions",
        args: [BigInt(p.tokenId)],
      });
      const liquidity = pos[7];
      /* Full-range value: amount0 = L/sqrtP, amount1 = L*sqrtP (Q96 math). */
      const amount0 = (liquidity * Q96) / sqrtPriceX96;
      const amount1 = (liquidity * sqrtPriceX96) / Q96;
      let pendingUp = 0;
      if (p.gauge) {
        try {
          const earned = (await publicClient.readContract({
            address: p.gauge as `0x${string}`,
            abi: GAUGE_ABI,
            functionName: "earned",
            args: [account.address, BigInt(p.tokenId)],
          })) as bigint;
          pendingUp = Number(formatEther(earned));
        } catch {
          /* gauge variant without earned(account,tokenId) — value display only */
        }
      }
      await updateState((s) => {
        const rec = (s.treasuryLp ?? []).find((x) => x.id === p.id);
        if (!rec) return;
        rec.currentEthValue = Number(formatEther(amount0));
        rec.currentStonkValue = Number(formatEther(amount1));
        rec.pendingUpRewards = pendingUp;
        rec.valueUpdatedAt = Date.now();
      });
    } catch (err) {
      log(`value refresh for #${p.tokenId} failed (non-fatal): ${String(err).slice(0, 160)}`);
    }
  }
}

declare global {
  var __lauraSmartLp: { running: boolean; nextAttemptAt: number; lastValueRefreshAt: number } | undefined;
}

function lpState() {
  if (!globalThis.__lauraSmartLp) {
    globalThis.__lauraSmartLp = { running: false, nextAttemptAt: 0, lastValueRefreshAt: 0 };
  }
  return globalThis.__lauraSmartLp;
}

const FAILURE_BACKOFF_MS = 60 * 60_000;
const VALUE_REFRESH_MS = 15 * 60_000;
/** STONK worth pairing before an entry is attempted (dust guard) */
const MIN_STONK_FOR_ENTRY = 400;

/**
 * Scheduler entry point. Two jobs: (1) refresh open-position values every
 * ~15 min; (2) when no open position exists and the wallet holds enough
 * accumulated $STONKBROKER, enter one full-range position and stake it.
 * Skips while the launch executor holds the wallet; failures back off 1h.
 * Never throws.
 */
export async function runSmartLpTick(state: SwarmState): Promise<void> {
  const lp = lpState();
  if (lp.running) return;
  if (!state.settings.autoTreasuryOps) return;
  const now = Date.now();

  lp.running = true;
  try {
    if (now - lp.lastValueRefreshAt >= VALUE_REFRESH_MS && (state.treasuryLp ?? []).some((p) => !p.exitedAt)) {
      lp.lastValueRefreshAt = now;
      await refreshLpValues(state);
    }

    if (now < lp.nextAttemptAt) return;
    const open = (state.treasuryLp ?? []).filter((p) => !p.exitedAt);

    /* Stake retry: an open unstaked position (entry succeeded, stake failed). */
    const unstaked = open.find((p) => !p.gauge);
    if (unstaked) {
      if (globalThis.__lauraLaunchExecutor?.running) return;
      const res = await stakeLpPosition(unstaked.id);
      if (!res.ok) {
        lp.nextAttemptAt = now + FAILURE_BACKOFF_MS;
        log(`stake failed (backing off 1h): ${res.reason}`);
      }
      return;
    }
    if (open.length > 0) return;

    /* Entry: only when the accumulated STONK is worth pairing. */
    const stonkHeld = state.treasury?.stonkBalance ?? 0;
    if (stonkHeld < MIN_STONK_FOR_ENTRY) return;
    if (globalThis.__lauraLaunchExecutor?.running) {
      log("deferring LP entry: launch executor holds the wallet this tick");
      return;
    }
    const res = await enterLpPosition();
    if (res.ok && res.sent) {
      const staked = await stakeLpPosition(res.position.id);
      if (!staked.ok) log(`entry ok but stake failed (retries next tick): ${staked.reason}`);
    } else if (res.ok) {
      log(`LP entry skipped: ${res.reason}`);
      lp.nextAttemptAt = now + VALUE_REFRESH_MS; // quiet re-check cadence for benign skips
    } else {
      lp.nextAttemptAt = now + FAILURE_BACKOFF_MS;
      log(`LP entry failed (backing off 1h): ${res.reason}`);
    }
  } catch (err) {
    lp.nextAttemptAt = now + FAILURE_BACKOFF_MS;
    log(`smart-lp tick threw (backing off 1h): ${String(err)}`);
  } finally {
    lp.running = false;
  }
}
