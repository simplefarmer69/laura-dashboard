import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbiItem,
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
 * - Graduation proceeds are NOT creator income: the raise + LP fee reserve
 *   bond into a permanently locked pool. (Zero-raise bonds return the
 *   unsold supply to the creator.)
 *
 * Everything in this module is read-only except claimEarnings, and even
 * that only sends after simulateContract AND settings.autoClaimEarnings.
 */

const PAD_ABI = PAD_FULL_ABI_JSON as Abi;
/* Batched transport + patient retries: this RPC rate-limits bursts (429), and
   several workstreams share it. Earnings reads are never urgent. */
const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

/** Quote token per lane (pad.quote(), verified on-chain). Both are 18 decimals. */
export const QUOTE_TOKENS: Record<PadLane, { address: `0x${string}`; symbol: string }> = {
  weth: { address: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", symbol: "WETH" },
  stonk: { address: "0xe934e36A439C94017B64a3FecE66AF12099aBF50", symbol: "STONK" },
};

export const EARNINGS_POLICY = {
  /** Scheduler refresh cadence for the on-chain snapshot */
  refreshMs: 10 * 60_000,
  /** Claim only when the fallback ledger holds at least this much quote (dust guard) */
  claimMinQuote: 0.0001,
  /** At most one claim attempt per launch per day */
  claimCadenceMs: 24 * 3600_000,
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
        earnedQuote += Number(formatEther((taxWei * BigInt(core.creatorFeeBpsSnap)) / 10_000n));
        tradeCount += trades;
      }

      entries.push({
        proposalId: launch.id,
        launchId: launch.launchId as string,
        symbol: launch.symbol,
        lane: launch.lane,
        earnedQuote,
        claimableQuote: Number(formatEther(owedWei)),
        tradeCount,
        graduated: core.graduated,
        bonded: core.bonded,
        claimedQuote: prev?.claimedQuote ?? 0,
        lastClaimAt: prev?.lastClaimAt ?? null,
        deployBlock,
        scannedToBlock: Number(latestBlock),
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
 * Simulates first; only SENDS when settings.autoClaimEarnings is true
 * (default false while another agent owns on-chain transactions).
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
  const claimableQuote = Number(formatEther(owedWei));
  if (claimableQuote < EARNINGS_POLICY.claimMinQuote) {
    return {
      ok: true,
      sent: false,
      simulated: false,
      claimableQuote,
      note: `Claimable ${claimableQuote} below the ${EARNINGS_POLICY.claimMinQuote} dust threshold — nothing to flush (creator fees are push-paid on each trade; this ledger only fills when a push fails)`,
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

declare global {
  var __lauraEarnings: { lastRefreshAt: number } | undefined;
}

/**
 * Scheduler entry point: refreshes the treasury snapshot every ~10 minutes
 * and, ONLY when settings.autoClaimEarnings is on, claims any fallback
 * ledger over the dust threshold (max once per launch per day).
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
    `treasury ${snapshot.ethBalance.toFixed(5)} ETH · ${snapshot.wethBalance.toFixed(6)} WETH · earned ${snapshot.totalEarnedQuote.toFixed(6)} · claimable ${snapshot.totalClaimableQuote.toFixed(6)} across ${snapshot.launches.length} launches`,
  );

  if (!state.settings.autoClaimEarnings) return;
  for (const entry of snapshot.launches) {
    const cadenceOk = !entry.lastClaimAt || now - entry.lastClaimAt >= EARNINGS_POLICY.claimCadenceMs;
    if (entry.claimableQuote >= EARNINGS_POLICY.claimMinQuote && cadenceOk) {
      try {
        const res = await claimEarnings(entry.proposalId);
        if (res.ok && res.sent) log(`claimed ${res.claimedQuote} for $${entry.symbol} (tx ${res.txHash})`);
        else if (!res.ok) log(`claim of $${entry.symbol} failed: ${res.reason}`);
      } catch (err) {
        log(`claim of $${entry.symbol} threw (non-fatal): ${String(err)}`);
      }
    }
  }
}
