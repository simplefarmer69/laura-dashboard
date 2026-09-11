import {
  createPublicClient,
  createWalletClient,
  formatEther,
  formatUnits,
  http,
  parseAbiItem,
  zeroAddress,
} from "viem";
import type { Abi } from "viem";
import { LAUNCHPAD, ROBINHOOD_CHAIN, type PadLane } from "@/lib/launchpad/contracts";
import PAD_FULL_ABI_JSON from "@/lib/launchpad/StonkSafeLaunchpadV2.abi.json";
import { getAccount } from "@/lib/launchpad/service";
import { loadState, pushEvent, updateState } from "@/lib/store";
import type { LaunchEarnings, LaunchProposal, SwarmState, TreasurySnapshot } from "@/lib/types";

/**
 * Creator earnings on the Smart Launch V2 pads — LAURA's income stream.
 *
 * Verified against the verified pad source on Robinhood Blockscout
 * (StonkSafeLaunchpadV2._splitTax / _pushCreatorQuote / flushCreatorQuote):
 *
 * - Every curve trade (buy AND sell) pays a tax. The pad splits it:
 *   creatorFeeBpsSnap (16.5% today) to the CREATOR, protocolFeeBpsSnap
 *   (16.5%) to the protocol treasury, lpFeeBps (50%) escrowed for the
 *   locked bond pool, remainder (~17%) to referral/Clock In machinery.
 * - The creator share is PUSH-PAID instantly: the pad calls
 *   quote.transfer(creator, amount) inside the trade. On the WETH lane the
 *   income therefore lands in LAURA's wallet as WETH on every taxed trade.
 * - Only when that push transfer fails does the amount accrue into
 *   creatorQuoteOwed[id] (event CreatorQuoteAccrued). flushCreatorQuote(id)
 *   is the permissionless claim that pays the owed balance to the creator
 *   (event CreatorQuoteFlushed). That is the claim path prepared here.
 * - GRADUATION does not end the income (verified against SafeLaunchBondLibV2
 *   + StonkUpLockerCL sources on Blockscout, 2026-09-10): bond() locks the
 *   raise + LP fee reserve into a permanent pool position, but the LOCK NFT,
 *   which carries the fee-claim right, is transferred to the CREATOR
 *   (`lockNft.transferFrom(pad, creator, lockTokenId)`, FeeMode
 *   CollectTwentyPercent). LAURA holds that NFT and can call
 *   StonkUpLockerCL.collectFees(lockId, 0, 0) to collect 80% of the pool's
 *   accrued swap fees (20% protocol cut) for as long as the pool trades.
 *   The pad exposes the lock ids via poolsOf(id). While a lock is staked in
 *   a gauge its swap fees go to the pool's voters, so collect is skipped.
 * - Graduation PRINCIPAL stays locked forever; only the raise of a
 *   zero-raise bond returns the unsold supply to the creator.
 *
 * Everything in this module is read-only except claimEarnings and
 * collectLpFees, and those only send after simulateContract AND
 * settings.autoClaimEarnings.
 */

const PAD_ABI = PAD_FULL_ABI_JSON as Abi;
/* Batched transport + patient retries: this RPC rate-limits bursts (429), and
   several workstreams share it. Earnings reads are never urgent. */
const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

/** Quote token per lane (pad.quote(), verified on-chain 2026-09-10).
 * NOTE: USDG is 6 decimals — always format quote amounts with formatQuote,
 * never a bare formatEther. */
export const QUOTE_TOKENS: Record<PadLane, { address: `0x${string}`; symbol: string; decimals: number }> = {
  weth: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH", decimals: 18 },
  stonk: { address: "0xe934e36A439C94017B64a3FecE66AF12099aBF50", symbol: "STONK", decimals: 18 },
  usdg: { address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", symbol: "USDG", decimals: 6 },
  gme: { address: "0x1b0E319c6A659F002271B69dB8A7df2F911c153E", symbol: "GME", decimals: 18 },
  nvda: { address: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", symbol: "NVDA", decimals: 18 },
  aapl: { address: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", symbol: "AAPL", decimals: 18 },
  spcx: { address: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", symbol: "SPCX", decimals: 18 },
  uso: { address: "0xa30FA36Db767ad9eD3f7a60fC79526fB4d56D344", symbol: "USO", decimals: 18 },
};

/** Format a quote-token wei amount using the lane's real decimals. */
function formatQuote(lane: PadLane, wei: bigint): number {
  return Number(formatUnits(wei, QUOTE_TOKENS[lane].decimals));
}

/** Env override for the claim dust threshold (ETH-equivalent). */
const envClaimMinEth = Number(process.env.FEE_CLAIM_MIN_ETH);
/** Env override for the eager-collect threshold (ETH-equivalent). */
const envCollectEagerEth = Number(process.env.FEE_COLLECT_EAGER_ETH);

export const EARNINGS_POLICY = {
  /** Scheduler refresh cadence for the on-chain snapshot */
  refreshMs: 10 * 60_000,
  /**
   * Claim/collect only when the pending value is worth at least this much in
   * ETH-equivalent terms (gas is never wasted on dust). Applies to both the
   * flushCreatorQuote fallback ledger and locked-LP collectFees. Non-WETH
   * lanes convert through the lens USD views; override with FEE_CLAIM_MIN_ETH.
   */
  claimMinEthEquiv: Number.isFinite(envClaimMinEth) && envClaimMinEth > 0 ? envClaimMinEth : 0.0005,
  /** At most one claim attempt per launch per day (unless the eager threshold fires) */
  claimCadenceMs: 24 * 3600_000,
  /**
   * Eager-collect bypass: when a launch's pending value reaches this much in
   * ETH-equivalent terms, claim/collect immediately instead of waiting out the
   * daily cadence. Added 2026-09-11 after $LAURA's high-velocity bonded pool
   * re-accrued ~0.5 WETH of LP fees within hours of a collect — real income
   * should not sit uncollected for a day. Gas on Robinhood Chain is trivial
   * relative to this threshold. Override with FEE_COLLECT_EAGER_ETH.
   */
  collectEagerEthEquiv: Number.isFinite(envCollectEagerEth) && envCollectEagerEth > 0 ? envCollectEagerEth : 0.02,
  /** getLogs chunk size the RPC tolerates */
  logChunkBlocks: 400_000n,
} as const;

const ERC20_BALANCE_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Lens USD views used to express lane-quote amounts in ETH-equivalent terms. */
const LENS_USD_ABI = [
  {
    type: "function",
    name: "ethUsdView",
    stateMutability: "view",
    inputs: [{ name: "pad", type: "address" }],
    outputs: [
      { name: "usd8", type: "uint256" },
      { name: "fresh", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "quoteUsdView",
    stateMutability: "view",
    inputs: [{ name: "pad", type: "address" }],
    outputs: [
      { name: "usd8", type: "uint256" },
      { name: "fresh", type: "bool" },
    ],
  },
] as const;

/**
 * Shared locker surface (verified sources on Blockscout): the CL box locker
 * (StonkUpLockerCL, bondVenue 0) and the v3 box locker (StonkLiquidityLocker,
 * bondVenue 1) expose identical lockNft() and collectFees() signatures.
 * collectFees is the creator's LP fee claim: only the lock NFT owner can call
 * it; it collects the position's accrued swap fees and pays the caller 80%
 * of both sides (FeeMode CollectTwentyPercent).
 */
const LOCKER_ABI = [
  {
    type: "function",
    name: "lockNft",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    type: "function",
    name: "collectFees",
    stateMutability: "nonpayable",
    inputs: [
      { name: "lockTokenId", type: "uint256" },
      { name: "amount0Max", type: "uint128" },
      { name: "amount1Max", type: "uint128" },
    ],
    outputs: [
      { name: "userAmount0", type: "uint256" },
      { name: "userAmount1", type: "uint256" },
      { name: "protocolAmount0", type: "uint256" },
      { name: "protocolAmount1", type: "uint256" },
    ],
  },
] as const;

/** CL locker lock struct: has tickSpacing and a gauge slot (stakeable). */
const CL_LOCK_POSITIONS_ABI = [
  {
    type: "function",
    name: "lockPositions",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "positionTokenId", type: "uint256" },
      { name: "lockTokenId", type: "uint256" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "tickSpacing", type: "int24" },
      { name: "initialLiquidity", type: "uint128" },
      { name: "withdrawnLiquidity", type: "uint128" },
      { name: "startUnlock", type: "uint64" },
      { name: "finishUnlock", type: "uint64" },
      { name: "feeMode", type: "uint8" },
      { name: "closed", type: "bool" },
      { name: "gauge", type: "address" },
    ],
  },
] as const;

/** v3 locker lock struct: no tickSpacing, no gauge (v3 locks cannot be staked). */
const V3_LOCK_POSITIONS_ABI = [
  {
    type: "function",
    name: "lockPositions",
    stateMutability: "view",
    inputs: [{ name: "", type: "uint256" }],
    outputs: [
      { name: "positionTokenId", type: "uint256" },
      { name: "lockTokenId", type: "uint256" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "initialLiquidity", type: "uint128" },
      { name: "withdrawnLiquidity", type: "uint128" },
      { name: "startUnlock", type: "uint64" },
      { name: "finishUnlock", type: "uint64" },
      { name: "feeMode", type: "uint8" },
      { name: "closed", type: "bool" },
    ],
  },
] as const;

const ERC721_OWNER_OF_ABI = [
  {
    type: "function",
    name: "ownerOf",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "address" }],
  },
] as const;

/* Event shapes per the official integration guide (StonkBrokers-Launchpad.pdf §9.5) */
const SAFE_BUY_EVENT = parseAbiItem(
  "event SafeBuy(uint256 indexed id, address indexed buyer, uint256 quoteIn, uint256 taxPaid, uint256 taxBps, uint256 tokensOut, uint256 mcapUsd8)",
);
const SAFE_SELL_EVENT = parseAbiItem(
  "event SafeSell(uint256 indexed id, address indexed seller, uint256 tokensIn, uint256 taxPaid, uint256 taxBps, uint256 quoteOut, uint256 mcapUsd8)",
);

function log(msg: string): void {
  console.log(`[earnings ${new Date().toISOString()}] ${msg}`);
}

function padAddress(lane: PadLane): `0x${string}` {
  return LAUNCHPAD.pads[lane] as `0x${string}`;
}

function trackedLaunches(state: SwarmState): LaunchProposal[] {
  return state.launches.filter((l) => l.status === "deployed" && l.launchId && l.tokenAddress);
}

/**
 * ETH value of ONE unit of a lane's quote token, from the lens USD oracles.
 * WETH is 1 by identity. Returns null when the oracle read fails or is
 * unusable; callers must then treat pending value as below threshold (never
 * claim on an unpriced lane, so gas is never wasted on mispriced dust).
 */
async function quoteEthRate(lane: PadLane): Promise<number | null> {
  if (lane === "weth") return 1;
  try {
    const pad = padAddress(lane);
    const lens = LAUNCHPAD.lens as `0x${string}`;
    const [ethUsd, quoteUsd] = await Promise.all([
      publicClient.readContract({ address: lens, abi: LENS_USD_ABI, functionName: "ethUsdView", args: [pad] }),
      publicClient.readContract({ address: lens, abi: LENS_USD_ABI, functionName: "quoteUsdView", args: [pad] }),
    ]);
    const eth = Number(ethUsd[0]);
    const quote = Number(quoteUsd[0]);
    if (!Number.isFinite(eth) || !Number.isFinite(quote) || eth <= 0 || quote <= 0) return null;
    return quote / eth;
  } catch {
    return null;
  }
}

/** One lock NFT held for a bonded launch, with its uncollected creator fee share. */
interface LockRead {
  lockId: bigint;
  locker: `0x${string}`;
  staked: boolean;
  /** Creator's 80% share of uncollected swap fees, lane-quote side. */
  pendingQuote: number;
  /** Creator's 80% share, launch-token side (pad-minted tokens are 18 decimals). */
  pendingToken: number;
}

/**
 * Reads the locked-LP fee state for one BONDED launch: which lock NFTs the
 * swarm wallet holds (poolsOf lock ids whose lockNft owner is us), whether
 * they are gauge-staked, and the pending creator fee share found by
 * SIMULATING collectFees(lockId, 0, 0) from the wallet (read-only; the
 * locker pays the realized balance delta, so the simulation returns the
 * exact user amounts a real send would pay right now).
 */
async function readLpLocks(launch: LaunchProposal, wallet: `0x${string}`): Promise<LockRead[]> {
  const pad = padAddress(launch.lane);
  const id = BigInt(launch.launchId as string);
  const [poolsRes, modes] = await Promise.all([
    publicClient.readContract({ address: pad, abi: PAD_ABI, functionName: "poolsOf", args: [id] }) as Promise<
      readonly [readonly `0x${string}`[], readonly bigint[]]
    >,
    publicClient.readContract({ address: pad, abi: PAD_ABI, functionName: "modesOf", args: [id] }) as Promise<{
      bondVenue: number;
    }>,
  ]);
  const lockIds = poolsRes[1] ?? [];
  if (lockIds.length === 0) return [];

  const isV3 = modes.bondVenue === 1;
  const locker = (await publicClient.readContract({
    address: pad,
    abi: PAD_ABI,
    functionName: isV3 ? "boxLockerV3" : "boxLocker",
  })) as `0x${string}`;
  const lockNft = await publicClient.readContract({ address: locker, abi: LOCKER_ABI, functionName: "lockNft" });

  const quoteAddr = QUOTE_TOKENS[launch.lane].address.toLowerCase();
  const locks: LockRead[] = [];
  for (const lockId of lockIds) {
    const owner = await publicClient
      .readContract({ address: lockNft, abi: ERC721_OWNER_OF_ABI, functionName: "ownerOf", args: [lockId] })
      .catch(() => null);
    if (!owner || owner.toLowerCase() !== wallet.toLowerCase()) continue;

    /* The two lockers store different structs: only the CL locker has a gauge
       slot (stakeable); v3 locks can never be staked. */
    let token0: `0x${string}`;
    let staked: boolean;
    if (isV3) {
      const pos = await publicClient.readContract({
        address: locker,
        abi: V3_LOCK_POSITIONS_ABI,
        functionName: "lockPositions",
        args: [lockId],
      });
      token0 = pos[2];
      staked = false;
    } else {
      const pos = await publicClient.readContract({
        address: locker,
        abi: CL_LOCK_POSITIONS_ABI,
        functionName: "lockPositions",
        args: [lockId],
      });
      token0 = pos[2];
      staked = pos[11] !== zeroAddress;
    }

    let pendingQuote = 0;
    let pendingToken = 0;
    if (!staked) {
      /* collectFees reverts while staked (gauge owns the position); otherwise
         the simulation is a safe, exact read of what a send would pay us. */
      try {
        const { result } = await publicClient.simulateContract({
          account: wallet,
          address: locker,
          abi: LOCKER_ABI,
          functionName: "collectFees",
          args: [lockId, 0n, 0n],
        });
        const [user0, user1] = result;
        const quoteIsToken0 = token0.toLowerCase() === quoteAddr;
        pendingQuote = formatQuote(launch.lane, quoteIsToken0 ? user0 : user1);
        pendingToken = Number(formatEther(quoteIsToken0 ? user1 : user0));
      } catch (err) {
        log(`collectFees simulation failed for lock ${lockId} ($${launch.symbol}), treating as 0: ${String(err).slice(0, 160)}`);
      }
    }
    locks.push({ lockId, locker, staked, pendingQuote, pendingToken });
  }
  return locks;
}

/** Sum of tax paid on curve trades for one launch over a block range. */
async function sumTradeTax(
  pad: `0x${string}`,
  launchId: bigint,
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ taxWei: bigint; trades: number }> {
  let taxWei = 0n;
  let trades = 0;
  for (let start = fromBlock; start <= toBlock; start += EARNINGS_POLICY.logChunkBlocks + 1n) {
    const end = start + EARNINGS_POLICY.logChunkBlocks > toBlock ? toBlock : start + EARNINGS_POLICY.logChunkBlocks;
    const [buys, sells] = await Promise.all([
      publicClient.getLogs({ address: pad, event: SAFE_BUY_EVENT, args: { id: launchId }, fromBlock: start, toBlock: end }),
      publicClient.getLogs({ address: pad, event: SAFE_SELL_EVENT, args: { id: launchId }, fromBlock: start, toBlock: end }),
    ]);
    for (const l of buys) taxWei += l.args.taxPaid ?? 0n;
    for (const l of sells) taxWei += l.args.taxPaid ?? 0n;
    trades += buys.length + sells.length;
  }
  return { taxWei, trades };
}

/**
 * Reads the live earnings picture for every deployed launch plus the wallet
 * treasury balances, and records the snapshot into state.treasury.
 * Read-only on chain; never throws (returns null on failure).
 */
export async function refreshEarnings(): Promise<TreasurySnapshot | null> {
  try {
    const account = getAccount();
    const state = await loadState();
    const launches = trackedLaunches(state);
    const prevByProposal = new Map((state.treasury?.launches ?? []).map((e) => [e.proposalId, e]));

    const [ethBalance, wethBalance, stonkBalance, latestBlock] = await Promise.all([
      account ? publicClient.getBalance({ address: account.address }) : Promise.resolve(0n),
      account
        ? publicClient.readContract({
            address: QUOTE_TOKENS.weth.address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [account.address],
          })
        : Promise.resolve(0n),
      account
        ? publicClient.readContract({
            address: QUOTE_TOKENS.stonk.address,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [account.address],
          })
        : Promise.resolve(0n),
      publicClient.getBlockNumber(),
    ]);

    const entries: LaunchEarnings[] = [];
    for (const launch of launches) {
      const pad = padAddress(launch.lane);
      const id = BigInt(launch.launchId as string);
      const prev = prevByProposal.get(launch.id);

      let deployBlock = prev?.deployBlock ?? 0;
      if (!deployBlock && launch.txHash) {
        const receipt = await publicClient.getTransactionReceipt({ hash: launch.txHash as `0x${string}` });
        deployBlock = Number(receipt.blockNumber);
      }

      const [owedWei, core] = await Promise.all([
        publicClient.readContract({ address: pad, abi: PAD_ABI, functionName: "creatorQuoteOwed", args: [id] }) as Promise<bigint>,
        publicClient.readContract({ address: pad, abi: PAD_ABI, functionName: "getLaunch", args: [id] }) as Promise<{
          creatorFeeBpsSnap: number;
          graduated: boolean;
          bonded: boolean;
        }>,
      ]);

      /* Incremental scan: only blocks we have not seen yet. */
      const fromBlock = BigInt((prev?.scannedToBlock ?? deployBlock - 1) + 1);
      let earnedQuote = prev?.earnedQuote ?? 0;
      let tradeCount = prev?.tradeCount ?? 0;
      if (fromBlock <= latestBlock) {
        const { taxWei, trades } = await sumTradeTax(pad, id, fromBlock, latestBlock);
        earnedQuote += formatQuote(launch.lane, (taxWei * BigInt(core.creatorFeeBpsSnap)) / 10_000n);
        tradeCount += trades;
      }

      /* Bonded launches keep earning: the lock NFT in the wallet claims the
         locked pool's swap fees. Read-only detection; a failed read degrades
         to the previous values instead of blanking them. */
      let locks: LockRead[] = [];
      if (core.bonded && account) {
        try {
          locks = await readLpLocks(launch, account.address);
        } catch (err) {
          log(`LP lock read failed for $${launch.symbol} (non-fatal): ${String(err).slice(0, 160)}`);
        }
      }

      entries.push({
        proposalId: launch.id,
        launchId: launch.launchId as string,
        symbol: launch.symbol,
        lane: launch.lane,
        earnedQuote,
        claimableQuote: formatQuote(launch.lane, owedWei),
        tradeCount,
        graduated: core.graduated,
        bonded: core.bonded,
        claimedQuote: prev?.claimedQuote ?? 0,
        lastClaimAt: prev?.lastClaimAt ?? null,
        deployBlock,
        scannedToBlock: Number(latestBlock),
        lockIds: locks.length > 0 ? locks.map((l) => l.lockId.toString()) : prev?.lockIds,
        lpStaked: locks.length > 0 ? locks.some((l) => l.staked) : prev?.lpStaked,
        lpPendingQuote: locks.length > 0 ? locks.reduce((s, l) => s + l.pendingQuote, 0) : prev?.lpPendingQuote,
        lpPendingToken: locks.length > 0 ? locks.reduce((s, l) => s + l.pendingToken, 0) : prev?.lpPendingToken,
        lpCollectedQuote: prev?.lpCollectedQuote ?? 0,
        lpCollectedToken: prev?.lpCollectedToken ?? 0,
        lpLastCollectAt: prev?.lpLastCollectAt ?? null,
      });
    }

    const snapshot: TreasurySnapshot = {
      updatedAt: Date.now(),
      walletAddress: account?.address ?? null,
      ethBalance: Number(formatEther(ethBalance)),
      wethBalance: Number(formatEther(wethBalance)),
      stonkBalance: Number(formatEther(stonkBalance)),
      totalEarnedQuote: entries.reduce((s, e) => s + e.earnedQuote, 0),
      totalClaimableQuote: entries.reduce((s, e) => s + e.claimableQuote, 0),
      totalClaimedQuote: entries.reduce((s, e) => s + e.claimedQuote, 0),
      totalLpPendingQuote: entries.reduce((s, e) => s + (e.lpPendingQuote ?? 0), 0),
      totalLpCollectedQuote: entries.reduce((s, e) => s + (e.lpCollectedQuote ?? 0), 0),
      launches: entries,
    };

    const prevTotal = state.treasury?.totalEarnedQuote ?? 0;
    await updateState((s) => {
      s.treasury = snapshot;
      if (snapshot.totalEarnedQuote > prevTotal + 1e-12) {
        pushEvent(s, {
          kind: "earnings.accrued",
          agentId: "system",
          title: `Creator fees earned: +${(snapshot.totalEarnedQuote - prevTotal).toFixed(6)} (quote) from launch trades`,
          detail: `Lifetime creator earnings ${snapshot.totalEarnedQuote.toFixed(6)} across ${entries.length} launches · pushed straight to the wallet as the lane's quote token (WETH on the WETH lane) · treasury ${snapshot.ethBalance.toFixed(5)} ETH + ${snapshot.wethBalance.toFixed(6)} WETH`,
          refId: null,
        });
      }
      return null;
    });
    return snapshot;
  } catch (err) {
    log(`refresh failed (non-fatal): ${String(err)}`);
    return null;
  }
}

export type ClaimResult =
  | { ok: true; sent: true; txHash: string; claimedQuote: number }
  | { ok: true; sent: false; simulated: boolean; claimableQuote: number; note: string }
  | { ok: false; reason: string };

/**
 * Claims the fallback creator-fee ledger for one launch via
 * flushCreatorQuote(id) — permissionless, always pays the creator.
 * Simulates first; only SENDS when settings.autoClaimEarnings is true.
 */
export async function claimEarnings(proposalId: string): Promise<ClaimResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const state = await loadState();
  const launch = state.launches.find((l) => l.id === proposalId);
  if (!launch?.launchId) return { ok: false, reason: "Launch has no on-chain id" };

  const pad = padAddress(launch.lane);
  const id = BigInt(launch.launchId);
  const owedWei = (await publicClient.readContract({
    address: pad,
    abi: PAD_ABI,
    functionName: "creatorQuoteOwed",
    args: [id],
  })) as bigint;
  const claimableQuote = formatQuote(launch.lane, owedWei);
  const rate = claimableQuote > 0 ? await quoteEthRate(launch.lane) : null;
  const claimableEthEquiv = rate === null ? 0 : claimableQuote * rate;
  if (claimableEthEquiv < EARNINGS_POLICY.claimMinEthEquiv) {
    return {
      ok: true,
      sent: false,
      simulated: false,
      claimableQuote,
      note: `Claimable ${claimableQuote} ${QUOTE_TOKENS[launch.lane].symbol} (~${claimableEthEquiv.toFixed(6)} ETH-equiv) below the ${EARNINGS_POLICY.claimMinEthEquiv} ETH-equiv dust threshold — nothing to flush (creator fees are push-paid on each trade; this ledger only fills when a push fails)`,
    };
  }

  const { request } = await publicClient.simulateContract({
    account,
    address: pad,
    abi: PAD_ABI,
    functionName: "flushCreatorQuote",
    args: [id],
  });

  if (!state.settings.autoClaimEarnings) {
    return {
      ok: true,
      sent: false,
      simulated: true,
      claimableQuote,
      note: "Simulation passed; sending is gated behind settings.autoClaimEarnings (currently false)",
    };
  }

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `flushCreatorQuote reverted: ${txHash}` };

  await updateState((s) => {
    const entry = s.treasury?.launches.find((e) => e.proposalId === proposalId);
    if (entry) {
      entry.claimedQuote += claimableQuote;
      entry.claimableQuote = 0;
      entry.lastClaimAt = Date.now();
    }
    if (s.treasury) {
      s.treasury.totalClaimableQuote = s.treasury.launches.reduce((sum, e) => sum + e.claimableQuote, 0);
      s.treasury.totalClaimedQuote = s.treasury.launches.reduce((sum, e) => sum + e.claimedQuote, 0);
    }
    pushEvent(s, {
      kind: "earnings.claimed",
      agentId: "system",
      title: `Claimed ${claimableQuote.toFixed(6)} creator fees for $${launch.symbol} (launch #${launch.launchId})`,
      detail: `flushCreatorQuote tx ${txHash} · proceeds paid to creator wallet in the ${launch.lane.toUpperCase()} lane quote token`,
      refId: proposalId,
    });
  });
  return { ok: true, sent: true, txHash, claimedQuote: claimableQuote };
}

export type LpCollectResult =
  | { ok: true; sent: true; txHashes: string[]; collectedQuote: number; collectedToken: number }
  | { ok: true; sent: false; simulated: boolean; pendingQuote: number; note: string }
  | { ok: false; reason: string };

/**
 * Collects the locked pool's accrued swap fees for one BONDED launch via
 * StonkUpLockerCL.collectFees on every lock NFT the swarm wallet holds.
 * This is inbound value only (the creator's 80% fee share, paid in the pool
 * pair: lane quote token + the launch's own token). Simulates first; only
 * SENDS when settings.autoClaimEarnings is true and the pending quote side
 * clears the ETH-equivalent dust threshold.
 */
export async function collectLpFees(proposalId: string): Promise<LpCollectResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const state = await loadState();
  const launch = state.launches.find((l) => l.id === proposalId);
  if (!launch?.launchId) return { ok: false, reason: "Launch has no on-chain id" };

  const locks = await readLpLocks(launch, account.address);
  if (locks.length === 0) {
    return { ok: false, reason: "No lock NFT held for this launch (not bonded yet, or the lock is not in the swarm wallet)" };
  }
  const claimable = locks.filter((l) => !l.staked && (l.pendingQuote > 0 || l.pendingToken > 0));
  const pendingQuote = claimable.reduce((s, l) => s + l.pendingQuote, 0);
  if (claimable.length === 0) {
    return {
      ok: true,
      sent: false,
      simulated: false,
      pendingQuote: 0,
      note: locks.every((l) => l.staked)
        ? "Lock is staked in a gauge; swap fees flow to the pool's voters while staked, nothing to collect here"
        : "No uncollected swap fees on the locked position yet",
    };
  }

  const rate = await quoteEthRate(launch.lane);
  const pendingEthEquiv = rate === null ? 0 : pendingQuote * rate;
  if (pendingEthEquiv < EARNINGS_POLICY.claimMinEthEquiv) {
    return {
      ok: true,
      sent: false,
      simulated: true,
      pendingQuote,
      note: `Pending ${pendingQuote.toFixed(8)} ${QUOTE_TOKENS[launch.lane].symbol} (~${pendingEthEquiv.toFixed(6)} ETH-equiv) below the ${EARNINGS_POLICY.claimMinEthEquiv} ETH-equiv dust threshold`,
    };
  }

  if (!state.settings.autoClaimEarnings) {
    return {
      ok: true,
      sent: false,
      simulated: true,
      pendingQuote,
      note: "collectFees simulation passed; sending is gated behind settings.autoClaimEarnings (currently false)",
    };
  }

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const txHashes: string[] = [];
  let collectedQuote = 0;
  let collectedToken = 0;
  for (const lock of claimable) {
    const { request } = await publicClient.simulateContract({
      account,
      address: lock.locker,
      abi: LOCKER_ABI,
      functionName: "collectFees",
      args: [lock.lockId, 0n, 0n],
    });
    const txHash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") return { ok: false, reason: `collectFees reverted on lock ${lock.lockId}: ${txHash}` };
    txHashes.push(txHash);
    collectedQuote += lock.pendingQuote;
    collectedToken += lock.pendingToken;
  }

  await updateState((s) => {
    const entry = s.treasury?.launches.find((e) => e.proposalId === proposalId);
    if (entry) {
      entry.lpCollectedQuote = (entry.lpCollectedQuote ?? 0) + collectedQuote;
      entry.lpCollectedToken = (entry.lpCollectedToken ?? 0) + collectedToken;
      entry.lpPendingQuote = 0;
      entry.lpPendingToken = 0;
      entry.lpLastCollectAt = Date.now();
    }
    if (s.treasury) {
      s.treasury.totalLpPendingQuote = s.treasury.launches.reduce((sum, e) => sum + (e.lpPendingQuote ?? 0), 0);
      s.treasury.totalLpCollectedQuote = s.treasury.launches.reduce((sum, e) => sum + (e.lpCollectedQuote ?? 0), 0);
    }
    pushEvent(s, {
      kind: "fees.claimed",
      agentId: "system",
      title: `Collected ${collectedQuote.toFixed(6)} ${QUOTE_TOKENS[launch.lane].symbol} + ${collectedToken.toFixed(2)} $${launch.symbol} LP fees from the bonded pool (launch #${launch.launchId}, ${launch.lane} lane)`,
      detail: `box locker collectFees via the creator lock NFT · tx ${txHashes.join(", ")} · 80% creator share of the locked pool's swap fees, paid to the swarm wallet`,
      refId: proposalId,
    });
  });
  return { ok: true, sent: true, txHashes, collectedQuote, collectedToken };
}

declare global {
  var __lauraEarnings: { lastRefreshAt: number } | undefined;
}

/**
 * Scheduler entry point: refreshes the treasury snapshot every ~10 minutes
 * and, ONLY when settings.autoClaimEarnings is on, runs the fee-claim pass:
 * flushes any fallback creator ledger and collects locked-LP swap fees on
 * bonded launches, each above the ETH-equivalent dust threshold (max one
 * claim attempt per launch per day per stream, except that pending value
 * above collectEagerEthEquiv fires immediately regardless of cadence).
 * Never throws — a flaky RPC must not take down the tick.
 */
export async function runEarningsMaintenance(state: SwarmState): Promise<void> {
  if (!globalThis.__lauraEarnings) globalThis.__lauraEarnings = { lastRefreshAt: 0 };
  const es = globalThis.__lauraEarnings;
  const now = Date.now();
  if (now - es.lastRefreshAt < EARNINGS_POLICY.refreshMs) return;
  if (trackedLaunches(state).length === 0 && es.lastRefreshAt !== 0) return;
  es.lastRefreshAt = now;

  const snapshot = await refreshEarnings();
  if (!snapshot) {
    /* Failed (usually a rate-limited RPC): retry in ~2 min instead of a full interval. */
    es.lastRefreshAt = now - (EARNINGS_POLICY.refreshMs - 2 * 60_000);
    return;
  }
  log(
    `treasury ${snapshot.ethBalance.toFixed(5)} ETH · ${snapshot.wethBalance.toFixed(6)} WETH · earned ${snapshot.totalEarnedQuote.toFixed(6)} · claimable ${snapshot.totalClaimableQuote.toFixed(6)} · LP pending ${(snapshot.totalLpPendingQuote ?? 0).toFixed(6)} across ${snapshot.launches.length} launches`,
  );

  if (!state.settings.autoClaimEarnings) return;
  for (const entry of snapshot.launches) {
    /* Eager bypass: a big-enough pending value (ETH-equivalent) skips the
       daily cadence — high-velocity pools like $LAURA's must not idle a day
       between collects. Rate is read once per entry, only when needed; an
       unpriced lane (null rate) never fires the bypass. */
    const wantsClaim = entry.claimableQuote > 0;
    const wantsLpCollect = (entry.lpPendingQuote ?? 0) > 0 && !entry.lpStaked;
    const rate = wantsClaim || wantsLpCollect ? await quoteEthRate(entry.lane) : null;
    const eager = (pendingQuote: number): boolean =>
      rate !== null && pendingQuote * rate >= EARNINGS_POLICY.collectEagerEthEquiv;

    /* Pass 1: flush the fallback creator-fee ledger (curve-phase income). */
    const cadenceOk = !entry.lastClaimAt || now - entry.lastClaimAt >= EARNINGS_POLICY.claimCadenceMs;
    if (wantsClaim && (cadenceOk || eager(entry.claimableQuote))) {
      if (!cadenceOk) log(`eager claim for $${entry.symbol}: pending ${entry.claimableQuote.toFixed(6)} quote exceeds the ${EARNINGS_POLICY.collectEagerEthEquiv} ETH-equiv threshold, bypassing the daily cadence`);
      try {
        const res = await claimEarnings(entry.proposalId);
        if (res.ok && res.sent) log(`claimed ${res.claimedQuote} for $${entry.symbol} (tx ${res.txHash})`);
        else if (!res.ok) log(`claim of $${entry.symbol} failed: ${res.reason}`);
      } catch (err) {
        log(`claim of $${entry.symbol} threw (non-fatal): ${String(err)}`);
      }
    }
    /* Pass 2: collect locked-LP swap fees on bonded launches (post-graduation
       income via the creator lock NFT). Threshold + gating live inside. */
    const lpCadenceOk = !entry.lpLastCollectAt || now - entry.lpLastCollectAt >= EARNINGS_POLICY.claimCadenceMs;
    if (wantsLpCollect && (lpCadenceOk || eager(entry.lpPendingQuote ?? 0))) {
      if (!lpCadenceOk) log(`eager LP collect for $${entry.symbol}: pending ${(entry.lpPendingQuote ?? 0).toFixed(6)} quote exceeds the ${EARNINGS_POLICY.collectEagerEthEquiv} ETH-equiv threshold, bypassing the daily cadence`);
      try {
        const res = await collectLpFees(entry.proposalId);
        if (res.ok && res.sent) {
          log(`collected LP fees for $${entry.symbol}: ${res.collectedQuote} quote + ${res.collectedToken} tokens (tx ${res.txHashes.join(",")})`);
        } else if (!res.ok) {
          log(`LP collect of $${entry.symbol} failed: ${res.reason}`);
        }
      } catch (err) {
        log(`LP collect of $${entry.symbol} threw (non-fatal): ${String(err)}`);
      }
    }
  }
}
