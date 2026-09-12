import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  type Abi,
} from "viem";
import PAD_FULL_ABI_JSON from "@/lib/launchpad/StonkSafeLaunchpadV2.abi.json";
import LENS_ABI_JSON from "@/lib/launchpad/SafeLaunchLensV2.abi.json";
import { LAUNCHPAD, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { getAccount } from "@/lib/launchpad/service";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import { ECO_CAPS, TREASURY_CAPS, ecoBuyEligibility, openEcoPositions } from "@/lib/launchpad/treasury-caps";
import { loadState, newId, pushEvent, updateState } from "@/lib/store";
import type { SwarmState, TreasuryEcoTrade } from "@/lib/types";

/**
 * Purser's on-chain hands (operator grant 2026-09-12: an agent that manages
 * the treasury, unwraps WETH, participates in the ecosystem, buys and sells
 * as she sees fit). Three primitives, every one simulate-first and capped:
 *
 *  - unwrapWeth: creator fees arrive as WETH on the weth lane; WETH.withdraw
 *    turns them into the ETH every other rail spends. Lossless, so the only
 *    guard is a dust floor.
 *  - ecoBuy / ecoSell: buy or sell ANOTHER builder's curve token on the Stonk
 *    Launcher's WETH pad through the pad's own buyEth/sell. This is real,
 *    fee-paying volume on the protocol LAURA promotes. Refused in code: her
 *    own launches (wash trading, charter) and the mission token (that is the
 *    accumulation ledger in treasury.ts). Caps live in ECO_CAPS.
 *
 * $STONKBROKER is never sold by any path in this codebase.
 */

const PAD_ABI = PAD_FULL_ABI_JSON as Abi;
const LENS_ABI = LENS_ABI_JSON as Abi;
const ZERO_REF = `0x${"0".repeat(64)}` as `0x${string}`;
const WETH_PAD = LAUNCHPAD.pads.weth as `0x${string}`;
const LENS = LAUNCHPAD.lens as `0x${string}`;

const WETH_ABI = [
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ERC20_ABI = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ name: "spender", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

function log(msg: string): void {
  console.log(`[purser ${new Date().toISOString()}] ${msg}`);
}

function walletFor(account: NonNullable<ReturnType<typeof getAccount>>) {
  return createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
}

/** True while another rail holds the wallet; a Purser send must never race a deploy or a swap for the nonce. */
export function walletBusy(): boolean {
  return Boolean(globalThis.__lauraLaunchExecutor?.running || globalThis.__lauraTreasuryOps?.running || globalThis.__lauraSmartLp?.running);
}

/* ------------------------------- WETH unwrap ------------------------------- */

export type UnwrapResult =
  | { ok: true; sent: true; ethOut: number; txHash: string }
  | { ok: true; sent: false; reason: string }
  | { ok: false; reason: string };

const MIN_UNWRAP_ETH = 0.0005;

/** WETH.withdraw: creator-fee WETH becomes spendable ETH. `amountEth` omitted = everything. */
export async function unwrapWeth(opts: { amountEth?: number; reason: string; runId: string }): Promise<UnwrapResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured (SWARM_WALLET_PRIVATE_KEY)" };
  const balance = (await publicClient.readContract({
    address: QUOTE_TOKENS.weth.address,
    abi: WETH_ABI,
    functionName: "balanceOf",
    args: [account.address],
  })) as bigint;
  const balanceEth = Number(formatEther(balance));
  const wantEth = opts.amountEth === undefined ? balanceEth : Math.min(opts.amountEth, balanceEth);
  if (wantEth < MIN_UNWRAP_ETH) {
    return { ok: true, sent: false, reason: `WETH balance ${balanceEth.toFixed(6)} (requested ${wantEth.toFixed(6)}) is under the ${MIN_UNWRAP_ETH} ETH dust floor` };
  }
  const wad = opts.amountEth === undefined ? balance : parseEther(wantEth.toFixed(18));
  const { request } = await publicClient.simulateContract({
    account,
    address: QUOTE_TOKENS.weth.address,
    abi: WETH_ABI,
    functionName: "withdraw",
    args: [wad],
  });
  const txHash = await walletFor(account).writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `WETH withdraw reverted: ${txHash}` };
  const ethOut = Number(formatEther(wad));
  await updateState((s) => {
    pushEvent(s, {
      kind: "treasury.unwrap",
      agentId: "treasurer",
      title: `Purser unwrapped ${ethOut.toFixed(5)} WETH into ETH`,
      detail: `${opts.reason} · tx ${txHash} · creator-fee WETH is now spendable ETH for buys, LP and launches (floor ${TREASURY_CAPS.treasuryFloorEth} ETH still applies to every spend)`,
      refId: opts.runId,
    });
  });
  log(`unwrapped ${ethOut.toFixed(5)} WETH (tx ${txHash})`);
  return { ok: true, sent: true, ethOut, txHash };
}

/* ---------------------------- Curve candidates ----------------------------- */

export interface EcoCandidate {
  launchId: number;
  token: `0x${string}`;
  symbol: string;
  creator: string;
  ageHours: number;
  mcapUsd: number;
  gradMcapUsd: number;
  /** Curve progress toward graduation, 0-100 */
  progressPct: number;
  buyCount: number;
  /** ETH actually raised on the curve */
  realQuoteEth: number;
  /** Current trade tax in basis points */
  taxBps: number;
  sellsEnabled: boolean;
  /** Purser already holds this token */
  held: boolean;
}

interface LaunchCore {
  token: `0x${string}`;
  creator: `0x${string}`;
  startMcapUsd8: bigint;
  gradMcapUsd8: bigint;
  startTime: bigint;
  armed: boolean;
  graduated: boolean;
  bonded: boolean;
  aborted: boolean;
  sellsEnabled: boolean;
  realQuote: bigint;
  buyCount: bigint;
}

interface LensView {
  taxBps: bigint;
  mcapUsd8Now: bigint;
}

const CANDIDATE_DEPTH = 40;
const MAX_CANDIDATES = 12;

/**
 * The newest live curves on the WETH pad that Purser may trade: armed, not
 * graduated/bonded/aborted, not LAURA's own launches, not the mission token.
 * Read-only; sorted by traction (buy count) with held tokens first.
 */
export async function ecoCandidates(state: SwarmState, now = Date.now()): Promise<EcoCandidate[]> {
  const own = new Set(state.launches.map((l) => l.tokenAddress?.toLowerCase()).filter(Boolean) as string[]);
  const stonk = QUOTE_TOKENS.stonk.address.toLowerCase();
  const held = new Set(openEcoPositions(state).map((p) => p.token));
  const count = Number((await publicClient.readContract({ address: WETH_PAD, abi: PAD_ABI, functionName: "launchCount" })) as bigint);
  const ids: number[] = [];
  for (let id = count - 1; id >= Math.max(0, count - CANDIDATE_DEPTH); id -= 1) ids.push(id);
  const cores = await Promise.all(
    ids.map(async (id) => {
      try {
        const core = (await publicClient.readContract({ address: WETH_PAD, abi: PAD_ABI, functionName: "getLaunch", args: [BigInt(id)] })) as LaunchCore;
        return { id, core };
      } catch {
        return null;
      }
    }),
  );
  const live = cores.filter((c): c is { id: number; core: LaunchCore } => {
    if (!c) return false;
    const { core } = c;
    if (!core.armed || core.graduated || core.bonded || core.aborted) return false;
    const t = core.token.toLowerCase();
    return !own.has(t) && t !== stonk;
  });
  const out = await Promise.all(
    live.map(async ({ id, core }) => {
      const [view, symbol] = await Promise.all([
        publicClient.readContract({ address: LENS, abi: LENS_ABI, functionName: "viewLaunch", args: [WETH_PAD, BigInt(id)] }).catch(() => null) as Promise<LensView | null>,
        publicClient.readContract({ address: core.token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?") as Promise<string>,
      ]);
      const gradUsd = Number(core.gradMcapUsd8) / 1e8;
      const mcapUsd = view ? Number(view.mcapUsd8Now) / 1e8 : Number(core.startMcapUsd8) / 1e8;
      const startUsd = Number(core.startMcapUsd8) / 1e8;
      const progress = gradUsd > startUsd ? Math.max(0, Math.min(100, ((mcapUsd - startUsd) / (gradUsd - startUsd)) * 100)) : 0;
      return {
        launchId: id,
        token: core.token,
        symbol,
        creator: core.creator,
        ageHours: Math.max(0, (now / 1000 - Number(core.startTime)) / 3600),
        mcapUsd,
        gradMcapUsd: gradUsd,
        progressPct: progress,
        buyCount: Number(core.buyCount),
        realQuoteEth: Number(formatEther(core.realQuote)),
        taxBps: view ? Number(view.taxBps) : 0,
        sellsEnabled: core.sellsEnabled,
        held: held.has(core.token.toLowerCase()),
      } satisfies EcoCandidate;
    }),
  );
  return out
    .sort((a, b) => Number(b.held) - Number(a.held) || b.buyCount - a.buyCount || a.ageHours - b.ageHours)
    .slice(0, MAX_CANDIDATES);
}

/** Read-only: what selling the whole held balance of each open position would return right now, in ETH. */
export async function valueEcoPositions(state: SwarmState): Promise<Array<{ token: string; symbol: string; launchId: number; tokens: number; ethIn: number; ethOut: number; lastTs: number; ethNow: number | null; tradable: boolean }>> {
  const account = getAccount();
  const open = openEcoPositions(state);
  if (!account || open.length === 0) return [];
  return Promise.all(
    open.map(async (p) => {
      try {
        const bal = (await publicClient.readContract({ address: p.token as `0x${string}`, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
        if (bal === 0n) return { ...p, tokens: 0, ethNow: 0, tradable: false };
        const [quoteOut] = (await publicClient.readContract({
          address: LENS,
          abi: LENS_ABI,
          functionName: "quoteSell",
          args: [WETH_PAD, BigInt(p.launchId), account.address, bal],
        })) as [bigint, bigint];
        return { ...p, tokens: Number(formatEther(bal)), ethNow: Number(formatEther(quoteOut)), tradable: true };
      } catch {
        return { ...p, ethNow: null, tradable: false };
      }
    }),
  );
}

/* --------------------------------- Trades ---------------------------------- */

export type EcoResult =
  | { ok: true; sent: true; trade: TreasuryEcoTrade }
  | { ok: true; sent: false; reason: string }
  | { ok: false; reason: string };

/** Charter + ledger guards shared by both sides. */
function ecoTokenGuard(state: SwarmState, token: string): string | null {
  const t = token.toLowerCase();
  if (t === QUOTE_TOKENS.stonk.address.toLowerCase()) return "the mission token is accumulated through the capped treasury buys, never traded on the launcher";
  const own = state.launches.find((l) => l.tokenAddress?.toLowerCase() === t);
  if (own) return `$${own.symbol} is LAURA's own launch; trading it would be wash trading (charter)`;
  return null;
}

/**
 * Buys `amountEth` of another builder's curve token through the WETH pad's
 * buyEth. Simulates for the quote, applies the slippage guard, checks the
 * treasury floor, sends, and records the trade from the real balance delta.
 */
export async function ecoBuy(opts: { launchId: number; token: `0x${string}`; amountEth: number; reason: string; runId: string }): Promise<EcoResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const state = await loadState();
  const guardReason = ecoTokenGuard(state, opts.token);
  if (guardReason) return { ok: false, reason: guardReason };
  const elig = ecoBuyEligibility(state, opts.token);
  if (!elig.eligible) return { ok: true, sent: false, reason: elig.reason };

  const core = (await publicClient.readContract({ address: WETH_PAD, abi: PAD_ABI, functionName: "getLaunch", args: [BigInt(opts.launchId)] })) as LaunchCore;
  if (core.token.toLowerCase() !== opts.token.toLowerCase()) return { ok: false, reason: `launch #${opts.launchId} is ${core.token}, not ${opts.token}; refusing a mismatched trade` };
  if (!core.armed || core.graduated || core.bonded || core.aborted) return { ok: true, sent: false, reason: `launch #${opts.launchId} is not a live curve (armed ${core.armed}, graduated ${core.graduated}, bonded ${core.bonded}, aborted ${core.aborted})` };

  let amountEth = Math.min(opts.amountEth, elig.amountEth, ECO_CAPS.maxEthPerTrade);
  const balanceEth = Number(formatEther(await publicClient.getBalance({ address: account.address })));
  const spendable = balanceEth - TREASURY_CAPS.treasuryFloorEth;
  amountEth = Math.min(amountEth, spendable);
  if (amountEth < ECO_CAPS.minEthPerTrade) {
    return { ok: true, sent: false, reason: `spendable ${Math.max(0, spendable).toFixed(4)} ETH above the ${TREASURY_CAPS.treasuryFloorEth} ETH floor leaves a buy under the ${ECO_CAPS.minEthPerTrade} ETH dust floor` };
  }
  const value = parseEther(amountEth.toFixed(18));

  const { result: quoted } = await publicClient.simulateContract({
    account,
    address: WETH_PAD,
    abi: PAD_ABI,
    functionName: "buyEth",
    args: [BigInt(opts.launchId), 0n, ZERO_REF, account.address],
    value,
  });
  const tokensQuoted = quoted as bigint;
  if (tokensQuoted === 0n) return { ok: false, reason: "buy simulation returned zero tokens" };
  const minOut = (tokensQuoted * BigInt(10_000 - ECO_CAPS.slippageBps)) / 10_000n;
  const { request } = await publicClient.simulateContract({
    account,
    address: WETH_PAD,
    abi: PAD_ABI,
    functionName: "buyEth",
    args: [BigInt(opts.launchId), minOut, ZERO_REF, account.address],
    value,
  });
  const before = (await publicClient.readContract({ address: opts.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  const txHash = await walletFor(account).writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `buyEth reverted: ${txHash}` };
  const after = (await publicClient.readContract({ address: opts.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  const symbol = ((await publicClient.readContract({ address: opts.token, abi: ERC20_ABI, functionName: "symbol" }).catch(() => "?")) as string) || "?";

  const trade: TreasuryEcoTrade = {
    id: newId("eco"),
    ts: Date.now(),
    side: "buy",
    launchId: opts.launchId,
    token: opts.token,
    symbol,
    ethAmount: amountEth,
    tokenAmount: Number(formatEther(after - before)),
    txHash,
    reason: opts.reason,
  };
  await updateState((s) => {
    s.treasuryEcoTrades = [...(s.treasuryEcoTrades ?? []), trade];
    pushEvent(s, {
      kind: "treasury.eco",
      agentId: "treasurer",
      title: `Purser bought ${trade.tokenAmount.toFixed(2)} $${symbol} for ${amountEth.toFixed(4)} ETH on the Stonk Launcher`,
      detail: `${opts.reason} · launch #${opts.launchId} (weth lane) · tx ${txHash} · eco 24h spend ${(elig.spent24hEth + amountEth).toFixed(4)}/${ECO_CAPS.maxEthPer24h} ETH · caps: ≤${ECO_CAPS.maxEthPerTrade} ETH/trade, ${ECO_CAPS.maxOpenPositions} positions, ${ECO_CAPS.perTokenGapHours}h per token, never own launches`,
      refId: trade.id,
    });
  });
  log(`bought ${trade.tokenAmount.toFixed(2)} ${symbol} for ${amountEth} ETH (launch #${opts.launchId}, tx ${txHash})`);
  return { ok: true, sent: true, trade };
}

/**
 * Sells `fraction` (0-1] of the wallet's real balance of a held eco token back
 * to the curve for native ETH (pad.sell with ethOut=true). Simulate-first for
 * the quote and the slippage guard; approves the pad only when needed.
 */
export async function ecoSell(opts: { token: `0x${string}`; fraction: number; reason: string; runId: string }): Promise<EcoResult> {
  const account = getAccount();
  if (!account) return { ok: false, reason: "No wallet configured" };
  const state = await loadState();
  const guardReason = ecoTokenGuard(state, opts.token);
  if (guardReason) return { ok: false, reason: guardReason };
  const position = openEcoPositions(state).find((p) => p.token === opts.token.toLowerCase());
  if (!position) return { ok: true, sent: false, reason: `no open eco position in ${opts.token}` };
  const fraction = Math.min(1, Math.max(0, opts.fraction));
  if (fraction === 0) return { ok: true, sent: false, reason: "fraction 0: nothing to sell" };

  const core = (await publicClient.readContract({ address: WETH_PAD, abi: PAD_ABI, functionName: "getLaunch", args: [BigInt(position.launchId)] })) as LaunchCore;
  if (core.graduated || core.bonded) return { ok: true, sent: false, reason: `$${position.symbol} has graduated off the curve; the pad sell path is closed (position stays held)` };
  if (!core.sellsEnabled) return { ok: true, sent: false, reason: `$${position.symbol} launch has sells disabled on the curve` };

  const balance = (await publicClient.readContract({ address: opts.token, abi: ERC20_ABI, functionName: "balanceOf", args: [account.address] })) as bigint;
  const tokensIn = fraction >= 1 ? balance : (balance * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  if (tokensIn === 0n) return { ok: true, sent: false, reason: "wallet holds none of this token" };

  const allowance = (await publicClient.readContract({ address: opts.token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, WETH_PAD] })) as bigint;
  const wallet = walletFor(account);
  if (allowance < tokensIn) {
    const { request } = await publicClient.simulateContract({ account, address: opts.token, abi: ERC20_ABI, functionName: "approve", args: [WETH_PAD, tokensIn] });
    const approveTx = await wallet.writeContract(request);
    const rc = await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
    if (rc.status !== "success") return { ok: false, reason: `approve reverted: ${approveTx}` };
  }
  const { result: quoted } = await publicClient.simulateContract({
    account,
    address: WETH_PAD,
    abi: PAD_ABI,
    functionName: "sell",
    args: [BigInt(position.launchId), tokensIn, 0n, ZERO_REF, account.address, true],
  });
  const quoteOut = quoted as bigint;
  if (quoteOut === 0n) return { ok: false, reason: "sell simulation returned zero ETH" };
  const minOut = (quoteOut * BigInt(10_000 - ECO_CAPS.slippageBps)) / 10_000n;
  const { request, result } = await publicClient.simulateContract({
    account,
    address: WETH_PAD,
    abi: PAD_ABI,
    functionName: "sell",
    args: [BigInt(position.launchId), tokensIn, minOut, ZERO_REF, account.address, true],
  });
  const txHash = await wallet.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") return { ok: false, reason: `sell reverted: ${txHash}` };

  const trade: TreasuryEcoTrade = {
    id: newId("eco"),
    ts: Date.now(),
    side: "sell",
    launchId: position.launchId,
    token: opts.token,
    symbol: position.symbol,
    ethAmount: Number(formatEther(result as bigint)),
    tokenAmount: Number(formatEther(tokensIn)),
    txHash,
    reason: opts.reason,
  };
  await updateState((s) => {
    s.treasuryEcoTrades = [...(s.treasuryEcoTrades ?? []), trade];
    const h = openEcoPositions(s).find((p) => p.token === opts.token.toLowerCase());
    pushEvent(s, {
      kind: "treasury.eco",
      agentId: "treasurer",
      title: `Purser sold ${trade.tokenAmount.toFixed(2)} $${position.symbol} for ${trade.ethAmount.toFixed(4)} ETH on the Stonk Launcher`,
      detail: `${opts.reason} · launch #${position.launchId} · tx ${txHash} · position cost ${position.ethIn.toFixed(4)} ETH, returned so far ${(position.ethOut + trade.ethAmount).toFixed(4)} ETH${h ? ` · ${h.tokens.toFixed(2)} still held` : " · position closed"}`,
      refId: trade.id,
    });
  });
  log(`sold ${trade.tokenAmount.toFixed(2)} ${position.symbol} for ${trade.ethAmount.toFixed(4)} ETH (tx ${txHash})`);
  return { ok: true, sent: true, trade };
}
