import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_MIN_ABI, LAUNCHPAD, PAD_ABI, PAD_LANE_KEYS, ROBINHOOD_CHAIN, type PadLane } from "@/lib/launchpad/contracts";
import { LANE_INFO, laneClosedReason } from "@/lib/launchpad/lanes";
import PAD_FULL_ABI_JSON from "@/lib/launchpad/StonkSafeLaunchpadV2.abi.json";
import type { Abi } from "viem";
import type { LaunchProposal } from "@/lib/types";

const PAD_FULL_ABI = PAD_FULL_ABI_JSON as Abi;

const publicClient = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http() });

/**
 * Hard operational caps. Deploys beyond these fail closed regardless of
 * approvals. These are the operator's standing safety config: hard constants,
 * not env-tunable. Raising them requires an explicit operator-authorized
 * change to this file, not a runtime knob.
 */
export const LAUNCH_CAPS = {
  /**
   * No daily count cap. Operator directive 2026-09-11: "LAURA should have no
   * limit of number of tokens she can launch per day". The pad's launch fee
   * is 0 wei and a deploy costs gas only, so the count never was the money
   * risk; the per-deploy spend cap and the wallet floor below are. What
   * bounds the count is Mint's own judgment (skip when there is nothing new
   * to say) and the pacing gap.
   */
  maxDeploysPerDay: null,
  /** Launch fee + gas budget per deploy */
  maxSpendEthPerDeploy: 0.02,
  /**
   * Pacing between consecutive deploys, not a cap: with a loaded queue and no
   * count limit the executor would otherwise fire one deploy per tick and
   * drop four tokens on the floor inside four minutes (Telegram shows each
   * as one line, the community reads it as spam). Twenty minutes gives every
   * launch its own arrival, buffer window and post, and still allows more
   * deploys a day than Mint could ever design (one spec per ~22-min cycle).
   */
  minDeployGapMinutes: 20,
  /**
   * The swarm wallet never deploys below this balance, so treasury ops and
   * fee claims always keep gas. Unrelated to the count; it is a floor.
   */
  walletFloorEth: 0.05,
} as const;

export interface WalletStatus {
  configured: boolean;
  address: string | null;
  balanceEth: number | null;
  funded: boolean;
}

export function getAccount() {
  const key = process.env.SWARM_WALLET_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) return null;
  return privateKeyToAccount(key as `0x${string}`);
}

export async function walletStatus(): Promise<WalletStatus> {
  const account = getAccount();
  if (!account) return { configured: false, address: null, balanceEth: null, funded: false };
  try {
    const balance = await publicClient.getBalance({ address: account.address });
    const balanceEth = Number(formatEther(balance));
    return { configured: true, address: account.address, balanceEth, funded: balanceEth > 0.002 };
  } catch {
    return { configured: true, address: account.address, balanceEth: null, funded: false };
  }
}

export interface PadState {
  lane: PadLane;
  address: string;
  launchFeeWei: string;
  launchCount: number;
  bounds: {
    minStartMcapUsd: number;
    maxStartMcapUsd: number;
    minGradMcapUsd: number;
    maxGradMcapUsd: number;
    maxStartTaxBps: number;
    minBufferSecs: number;
    maxOpenSecs: number;
  };
}

export async function padState(lane: PadLane): Promise<PadState> {
  const address = LAUNCHPAD.pads[lane] as `0x${string}`;
  const [fee, count, bounds] = await Promise.all([
    publicClient.readContract({ address, abi: PAD_ABI, functionName: "launchFeeWei" }),
    publicClient.readContract({ address, abi: PAD_ABI, functionName: "launchCount" }),
    publicClient.readContract({ address, abi: PAD_ABI, functionName: "bounds" }),
  ]);
  return {
    lane,
    address,
    launchFeeWei: fee.toString(),
    launchCount: Number(count),
    bounds: {
      minStartMcapUsd: Number(bounds[0]) / 1e8,
      maxStartMcapUsd: Number(bounds[1]) / 1e8,
      minGradMcapUsd: Number(bounds[2]) / 1e8,
      maxGradMcapUsd: Number(bounds[3]) / 1e8,
      maxStartTaxBps: Number(bounds[4]),
      minBufferSecs: Number(bounds[5]),
      maxOpenSecs: Number(bounds[6]),
    },
  };
}

/** PadState plus the lane facts the console and viewer render per lane. */
export interface LanePadState extends PadState {
  quoteSymbol: string;
  kind: "crypto" | "stock";
  /** Null when the lane can deploy right now (stock lanes close on weekends). */
  closedReason: string | null;
}

/* Batched transport for the all-lanes sweep (8 pads x 3 views): this RPC
   rate-limits bursts, and these reads back the console/viewer, not deploys. */
const batchedClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 3, retryDelay: 600 }),
});

async function lanePadState(lane: PadLane): Promise<LanePadState> {
  const address = LAUNCHPAD.pads[lane] as `0x${string}`;
  const [fee, count, bounds] = await Promise.all([
    batchedClient.readContract({ address, abi: PAD_ABI, functionName: "launchFeeWei" }),
    batchedClient.readContract({ address, abi: PAD_ABI, functionName: "launchCount" }),
    batchedClient.readContract({ address, abi: PAD_ABI, functionName: "bounds" }),
  ]);
  return {
    lane,
    address,
    launchFeeWei: fee.toString(),
    launchCount: Number(count),
    bounds: {
      minStartMcapUsd: Number(bounds[0]) / 1e8,
      maxStartMcapUsd: Number(bounds[1]) / 1e8,
      minGradMcapUsd: Number(bounds[2]) / 1e8,
      maxGradMcapUsd: Number(bounds[3]) / 1e8,
      maxStartTaxBps: Number(bounds[4]),
      minBufferSecs: Number(bounds[5]),
      maxOpenSecs: Number(bounds[6]),
    },
    quoteSymbol: LANE_INFO[lane].quote,
    kind: LANE_INFO[lane].kind,
    closedReason: laneClosedReason(lane),
  };
}

/**
 * Live state of every quote-lane pad, for the console and viewer snapshot.
 * Lanes whose reads fail are dropped rather than failing the sweep — the
 * console renders what answered and the deploy path re-reads its own pad.
 */
export async function allPadStates(): Promise<LanePadState[]> {
  const settled = await Promise.allSettled(PAD_LANE_KEYS.map((lane) => lanePadState(lane)));
  return settled.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
}

/**
 * The pads' tax-decay economics rule, pinned by createLaunch simulation on the
 * weth, spcx and gme pads (2026-09-11, ~50 parameter combinations): the start
 * tax must be an exact multiple of the per-minute decay, and the decay window
 * startTaxBps / taxDecayPerMinuteBps must be 10-99 minutes. Zero tax needs zero
 * decay (and vice versa). Anything else reverts BadEconomics() — BTCLEG
 * (2000/250 = 8 min) and HOUSTN (2000/400 = 5 min) burned four deploy attempts
 * on it before this was understood.
 */
export const TAX_DECAY_MIN_MINUTES = 10;
export const TAX_DECAY_MAX_MINUTES = 99;

export function taxDecayProblem(startTaxBps: number, decayBps: number): string | null {
  if (startTaxBps === 0 && decayBps === 0) return null;
  if (startTaxBps === 0 || decayBps === 0)
    return "Start tax and decay must be both zero or both positive (pad reverts BadEconomics())";
  if (startTaxBps % decayBps !== 0)
    return `Start tax ${startTaxBps} bps must be an exact multiple of the decay ${decayBps} bps/min (pad reverts BadEconomics())`;
  const minutes = startTaxBps / decayBps;
  if (minutes < TAX_DECAY_MIN_MINUTES || minutes > TAX_DECAY_MAX_MINUTES)
    return `Tax decay window ${minutes} min is outside the pad's ${TAX_DECAY_MIN_MINUTES}-${TAX_DECAY_MAX_MINUTES} min range (pad reverts BadEconomics())`;
  return null;
}

/**
 * Snaps a (startTax, decay) pair onto the pad rule, keeping the designer's
 * intended window as closely as possible: the window is clamped to 10-99 min,
 * then the nearest window length that divides the tax exactly wins. Taxes with
 * no such divisor are rounded down to a multiple of 10 bps first (every such
 * tax divides by 10 min). Returns the input unchanged when it already passes.
 */
export function normalizeTaxDecay(startTaxBps: number, decayBps: number): { startTaxBps: number; taxDecayPerMinuteBps: number } {
  if (!taxDecayProblem(startTaxBps, decayBps)) return { startTaxBps, taxDecayPerMinuteBps: decayBps };
  if (startTaxBps <= 0) return { startTaxBps: 0, taxDecayPerMinuteBps: 0 };
  const intended = decayBps > 0 ? startTaxBps / decayBps : TAX_DECAY_MIN_MINUTES;
  const target = Math.min(TAX_DECAY_MAX_MINUTES, Math.max(TAX_DECAY_MIN_MINUTES, Math.round(intended)));
  const pick = (tax: number): number | null => {
    for (let delta = 0; delta <= TAX_DECAY_MAX_MINUTES; delta++) {
      for (const m of [target - delta, target + delta]) {
        if (m < TAX_DECAY_MIN_MINUTES || m > TAX_DECAY_MAX_MINUTES) continue;
        if (tax % m === 0) return m;
      }
    }
    return null;
  };
  let tax = startTaxBps;
  let minutes = pick(tax);
  if (minutes === null) {
    tax = Math.max(10, Math.floor(tax / 10) * 10);
    minutes = pick(tax) ?? TAX_DECAY_MIN_MINUTES;
  }
  return { startTaxBps: tax, taxDecayPerMinuteBps: tax / minutes };
}

/** Validates a proposal against the pad's live on-chain bounds. Returns human-readable problems. */
export function validateAgainstBounds(p: LaunchProposal, pad: PadState): string[] {
  const problems: string[] = [];
  const b = pad.bounds;
  if (!/^[A-Za-z0-9 .\-']{3,48}$/.test(p.name)) problems.push("Name must be 3-48 plain characters");
  if (!/^[A-Z0-9]{2,10}$/.test(p.symbol)) problems.push("Symbol must be 2-10 uppercase alphanumerics");
  if (p.supplyTokens < 1_000_000 || p.supplyTokens > 1e12) problems.push("Supply must be 1M-1T tokens");
  if (p.startMcapUsd < b.minStartMcapUsd || p.startMcapUsd > b.maxStartMcapUsd)
    problems.push(`Start mcap must be $${b.minStartMcapUsd}-$${b.maxStartMcapUsd}`);
  if (p.gradMcapUsd < b.minGradMcapUsd || p.gradMcapUsd > b.maxGradMcapUsd)
    problems.push(`Graduation mcap must be $${b.minGradMcapUsd}-$${b.maxGradMcapUsd}`);
  if (p.gradMcapUsd <= p.startMcapUsd * 2) problems.push("Graduation mcap should be at least 2x start mcap");
  if (p.startTaxBps < 0 || p.startTaxBps > b.maxStartTaxBps)
    problems.push(`Start tax must be 0-${b.maxStartTaxBps} bps`);
  if (p.taxDecayPerMinuteBps < 0 || p.taxDecayPerMinuteBps > 2000)
    problems.push("Tax decay must be 0-2000 bps/min");
  const decayProblem = taxDecayProblem(p.startTaxBps, p.taxDecayPerMinuteBps);
  if (decayProblem) problems.push(decayProblem);
  if (p.bufferSecs < b.minBufferSecs) problems.push(`Buffer must be at least ${b.minBufferSecs}s`);
  /* Pad enforces MIN_POST_TAX_BPS()=100 / MAX_POST_TAX_BPS()=500 at create
     (verified by simulation on both pads 2026-09-10: postTaxBps 0 reverts). */
  if (p.postTaxBps < 100 || p.postTaxBps > 500) problems.push("Post tax must be 100-500 bps (pad minimum is enforced on-chain)");
  /* Modes the V2 pads reject as deployed (verified by simulation on all 8
     pads 2026-09-11, every parameter combination tested): refusing here saves
     the deploy attempt and names the on-chain error the pad would throw. */
  /* sellsEnabled false is not refused here any more: the executor probes the
     pad (probeBuyOnly) and falls back to sells-enabled when the pad reverts,
     so a buy-only request never burns a deploy and deploys as designed the
     day the pads accept it. */
  if (p.openEnded === false) problems.push("Closed-window sales revert BadParam() on every V2 pad; openEnded must be true");
  if (p.maxBuyPpm !== undefined && (p.maxBuyPpm < 0 || p.maxBuyPpm > 1_000_000)) problems.push("maxBuyPpm must be 0-1000000");
  if (p.bondVenue !== undefined && ![0, 1].includes(p.bondVenue)) problems.push("bondVenue must be 0 or 1");
  if (p.unsoldMode !== undefined && ![0, 1].includes(p.unsoldMode)) problems.push("unsoldMode must be 0 or 1 (2+ reverts BadParam())");
  return problems;
}

/**
 * Asks the pad whether it would accept this launch as a buy-only curve
 * (sellsEnabled false) by simulating createLaunch with the launch's own
 * parameters. Simulation only; no gas. Returns the revert name when refused.
 */
export async function probeBuyOnly(p: LaunchProposal): Promise<{ accepted: boolean; detail: string }> {
  const account = getAccount();
  if (!account) return { accepted: false, detail: "no wallet configured" };
  const pad = await padState(p.lane);
  const params = {
    token: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    name: p.name,
    symbol: p.symbol,
    supply: parseEther(String(p.supplyTokens)),
    vanitySalt: `0x${"0".repeat(64)}` as `0x${string}`,
    startMcapUsd8: BigInt(Math.round(p.startMcapUsd * 1e8)),
    gradMcapUsd8: BigInt(Math.round(p.gradMcapUsd * 1e8)),
    startTaxBps: p.startTaxBps,
    taxDecayPerMinuteBps: p.taxDecayPerMinuteBps,
    sellsEnabled: false,
    bufferSecs: p.bufferSecs,
    unsoldMode: p.unsoldMode ?? 0,
    eoaOnly: p.eoaOnly ?? false,
    openEnded: p.openEnded ?? true,
    postTaxBps: p.postTaxBps,
    bondVenue: p.bondVenue ?? 0,
    maxBuyPpm: p.maxBuyPpm ?? 0,
  };
  try {
    await publicClient.simulateContract({
      account,
      address: pad.address as `0x${string}`,
      abi: PAD_ABI,
      functionName: "createLaunch",
      args: [params],
      value: BigInt(pad.launchFeeWei),
    });
    return { accepted: true, detail: "pad accepted a buy-only curve in simulation" };
  } catch (err) {
    const m = String((err as Error).message ?? err);
    const name = m.match(/Error: (\w+)\(/)?.[1] ?? m.split("\n")[0].slice(0, 80);
    return { accepted: false, detail: `pad refused buy-only (${name})` };
  }
}

export interface DeployResult {
  txHash: string;
  launchId: string | null;
  tokenAddress: string | null;
  feePaidEth: number;
}

/**
 * Deploys an operator-approved launch on the Smart Launch V2 pad.
 * Fails closed: requires a configured funded wallet, live-bounds validation,
 * and the fee+gas estimate under the per-deploy cap. Caller enforces pacing and the wallet floor.
 */
export async function deployLaunch(p: LaunchProposal): Promise<DeployResult> {
  const account = getAccount();
  if (!account) throw new Error("No wallet configured (set SWARM_WALLET_PRIVATE_KEY)");
  const pad = await padState(p.lane);
  const problems = validateAgainstBounds(p, pad);
  if (problems.length) throw new Error(`Spec fails live pad bounds: ${problems.join("; ")}`);

  const address = pad.address as `0x${string}`;
  const fee = BigInt(pad.launchFeeWei);
  const params = {
    token: "0x0000000000000000000000000000000000000000" as `0x${string}`,
    name: p.name,
    symbol: p.symbol,
    supply: parseEther(String(p.supplyTokens)),
    vanitySalt: `0x${"0".repeat(64)}` as `0x${string}`,
    startMcapUsd8: BigInt(Math.round(p.startMcapUsd * 1e8)),
    gradMcapUsd8: BigInt(Math.round(p.gradMcapUsd * 1e8)),
    startTaxBps: p.startTaxBps,
    taxDecayPerMinuteBps: p.taxDecayPerMinuteBps,
    sellsEnabled: p.sellsEnabled,
    bufferSecs: p.bufferSecs,
    /* Operator-unlocked options (2026-09-11), defaulting to the proven params
       for launches queued before they existed. validateAgainstBounds refuses
       the combinations the pads revert on. */
    unsoldMode: p.unsoldMode ?? 0,
    eoaOnly: p.eoaOnly ?? false,
    openEnded: p.openEnded ?? true,
    postTaxBps: p.postTaxBps,
    bondVenue: p.bondVenue ?? 0,
    maxBuyPpm: p.maxBuyPpm ?? 0,
  };

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const { request, result } = await publicClient.simulateContract({
    account,
    address,
    abi: PAD_ABI,
    functionName: "createLaunch",
    args: [params],
    value: fee,
  });

  const gas = await publicClient.estimateContractGas({
    account,
    address,
    abi: PAD_ABI,
    functionName: "createLaunch",
    args: [params],
    value: fee,
  });
  const gasPrice = await publicClient.getGasPrice();
  const spendEth = Number(formatEther(fee + gas * gasPrice * BigInt(2)));
  if (spendEth > LAUNCH_CAPS.maxSpendEthPerDeploy) {
    throw new Error(
      `Estimated spend ${spendEth.toFixed(5)} ETH exceeds the ${LAUNCH_CAPS.maxSpendEthPerDeploy} ETH per-deploy cap`,
    );
  }

  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${txHash}`);

  let launchId: string | null = result ? String(result[0]) : null;
  let tokenAddress: string | null = result ? result[1] : null;
  const logs = parseEventLogs({ abi: PAD_ABI, logs: receipt.logs, eventName: "LaunchCreated" });
  if (logs[0]) {
    launchId = String(logs[0].args.id);
    tokenAddress = logs[0].args.token;
  }
  return { txHash, launchId, tokenAddress, feePaidEth: Number(formatEther(fee)) };
}

export interface OrphanDeploy {
  launchId: string;
  tokenAddress: string;
  armed: boolean;
}

const ERC20_META_ABI = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
] as const;

/**
 * Finds a launch this wallet created on `lane`'s pad whose token the store
 * does not know yet and whose ERC-20 name and symbol match the spec. Walks
 * the newest `depth` launch ids on the pad (`launchCount` → `getLaunch`).
 * Used to reconcile a record left in "deploying" when the process died
 * between the mined createLaunch tx and the state save (2026-09-11, $GRADED).
 */
export async function findOrphanDeploy(
  lane: PadLane,
  spec: { name: string; symbol: string },
  knownTokens: Set<string>,
  depth = 25,
): Promise<OrphanDeploy | null> {
  const account = getAccount();
  if (!account) return null;
  const address = LAUNCHPAD.pads[lane] as `0x${string}`;
  const count = (await publicClient.readContract({ address, abi: PAD_FULL_ABI, functionName: "launchCount" })) as bigint;
  const known = new Set([...knownTokens].map((t) => t.toLowerCase()));
  const me = account.address.toLowerCase();
  for (let id = count; id > 0n && count - id < BigInt(depth); id--) {
    const launch = (await publicClient.readContract({
      address,
      abi: PAD_FULL_ABI,
      functionName: "getLaunch",
      args: [id],
    })) as { token: `0x${string}`; creator: `0x${string}`; armed: boolean };
    if (launch.creator.toLowerCase() !== me) continue;
    if (known.has(launch.token.toLowerCase())) continue;
    const [name, symbol] = await Promise.all([
      publicClient.readContract({ address: launch.token, abi: ERC20_META_ABI, functionName: "name" }),
      publicClient.readContract({ address: launch.token, abi: ERC20_META_ABI, functionName: "symbol" }),
    ]);
    if (name !== spec.name || symbol !== spec.symbol) continue;
    return { launchId: String(id), tokenAddress: launch.token, armed: launch.armed };
  }
  return null;
}

/** True when the pad reports the launch's supply loaded and clock started. */
export async function isLaunchArmed(lane: PadLane, launchId: string): Promise<boolean> {
  const address = LAUNCHPAD.pads[lane] as `0x${string}`;
  const launch = (await publicClient.readContract({
    address,
    abi: PAD_FULL_ABI,
    functionName: "getLaunch",
    args: [BigInt(launchId)],
  })) as { armed: boolean };
  return launch.armed;
}

export interface ArmResult {
  armTxHash: string;
  alreadyArmed: boolean;
}

/**
 * Loads the token supply into the pad and starts the sale clock.
 * createLaunch only registers a launch (phase "waiting", startTime 0);
 * without this step the token never goes live. Idempotent: checks the
 * pad's `armed` flag first, and only approves when allowance is short.
 */
export async function armLaunch(p: LaunchProposal): Promise<ArmResult> {
  const account = getAccount();
  if (!account) throw new Error("No wallet configured (set SWARM_WALLET_PRIVATE_KEY)");
  if (!p.launchId || !p.tokenAddress) throw new Error("Launch has no on-chain id/token yet");

  const pad = LAUNCHPAD.pads[p.lane] as `0x${string}`;
  const token = p.tokenAddress as `0x${string}`;
  if (await isLaunchArmed(p.lane, p.launchId)) return { armTxHash: "", alreadyArmed: true };

  const supplyWei = parseEther(String(p.supplyTokens));
  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });

  const allowance = (await publicClient.readContract({
    address: token,
    abi: ERC20_MIN_ABI,
    functionName: "allowance",
    args: [account.address, pad],
  })) as bigint;
  if (allowance < supplyWei) {
    const approveTx = await walletClient.writeContract({
      address: token,
      abi: ERC20_MIN_ABI,
      functionName: "approve",
      args: [pad, supplyWei],
    });
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });
    if (approveReceipt.status !== "success") throw new Error(`Supply approve reverted: ${approveTx}`);
  }

  const { request } = await publicClient.simulateContract({
    account,
    address: pad,
    abi: PAD_ABI,
    functionName: "arm",
    args: [BigInt(p.launchId), supplyWei],
  });
  const armTxHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: armTxHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`Arm reverted: ${armTxHash}`);
  return { armTxHash, alreadyArmed: false };
}

export interface GridToken {
  token: string;
  name: string;
  symbol: string;
  priceUsd: number;
  mcapUsd: number;
  curvePct: number;
  holderCount: number;
  graduated: boolean;
  createdAt: string;
}

export interface LaunchVisibility {
  /** True when the token renders on the Stonklauncher UI as a live launch */
  visible: boolean;
  /** Floor phase ("waiting" | "live" | "bonded" | ...) or null when the row is missing */
  phase: string | null;
  /** Site-global floor id (lane idOffset + launchId), e.g. 18000276 for weth2 #276 */
  floorId: number | null;
  /** UI route for the token's trade page, e.g. /safe-launch/token/weth2-laura-276 */
  safeHref: string | null;
  imageAttached: boolean;
  detail: string;
}

interface FloorRow {
  id: number;
  name?: string;
  symbol?: string;
  phase?: string;
  loadedPct?: number;
  live?: { token?: string };
  profile?: { logo?: string };
  lane?: { key?: string };
}

/**
 * Confirms a deployed launch is actually user-visible on the Stonklauncher UI.
 * Reads the exact surface the /launcher page renders from (the floor rows) plus
 * the public grid (which carries the UI route + logo state). "Deployed" is not
 * "live": a created-but-unarmed launch sits in the floor's Waiting pile and the
 * operator will rightly say they don't see it. Only phase "live"/"bonded"/
 * "graduated" counts as visible.
 */
export async function verifyLaunchVisible(tokenAddress: string): Promise<LaunchVisibility> {
  const token = tokenAddress.toLowerCase();

  const floorRes = await fetch(LAUNCHPAD.floorApi, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!floorRes.ok) throw new Error(`floor HTTP ${floorRes.status}`);
  const floor = (await floorRes.json()) as { ok?: boolean; rows?: FloorRow[] };
  const row = (floor.rows ?? []).find((r) => r.live?.token?.toLowerCase() === token) ?? null;

  let safeHref: string | null = null;
  let gridImage = false;
  try {
    const gridRes = await fetch(`${LAUNCHPAD.gridApi}?sort=new`, {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal: AbortSignal.timeout(15_000),
    });
    if (gridRes.ok) {
      const grid = (await gridRes.json()) as {
        tokens?: { token: string; safeHref?: string; imageHash?: string }[];
      };
      const entry = (grid.tokens ?? []).find((t) => t.token.toLowerCase() === token);
      safeHref = entry?.safeHref ?? null;
      gridImage = Boolean(entry?.imageHash);
    }
  } catch {
    /* grid is corroborating evidence only; the floor row decides visibility */
  }

  const phase = row?.phase ?? null;
  const visible = phase === "live" || phase === "bonded" || phase === "graduated";
  const detail = row
    ? `floor id ${row.id} · phase ${phase} · loaded ${row.loadedPct ?? "?"}%${safeHref ? ` · ${safeHref}` : ""}`
    : "token not present in the floor rows the launcher UI renders";
  return {
    visible,
    phase,
    floorId: row?.id ?? null,
    safeHref,
    imageAttached: Boolean(row?.profile?.logo) || gridImage,
    detail,
  };
}

/** Live launcher grid from the official public API (for context in the console). */
export async function launcherGrid(sort = "new", limit = 12): Promise<GridToken[]> {
  const res = await fetch(`${LAUNCHPAD.gridApi}?sort=${sort}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`launcher grid HTTP ${res.status}`);
  const json = (await res.json()) as { ok: boolean; tokens: GridToken[] };
  return (json.tokens ?? []).slice(0, limit);
}
