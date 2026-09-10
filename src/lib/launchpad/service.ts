import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ERC20_MIN_ABI, LAUNCHPAD, PAD_ABI, ROBINHOOD_CHAIN, type PadLane } from "@/lib/launchpad/contracts";
import PAD_FULL_ABI_JSON from "@/lib/launchpad/StonkSafeLaunchpadV2.abi.json";
import type { Abi } from "viem";
import type { LaunchProposal } from "@/lib/types";

const PAD_FULL_ABI = PAD_FULL_ABI_JSON as Abi;

const publicClient = createPublicClient({ chain: ROBINHOOD_CHAIN, transport: http() });

/** Hard operational caps. Deploys beyond these fail closed regardless of approvals. */
export const LAUNCH_CAPS = {
  maxDeploysPerDay: 3,
  /** Launch fee + gas budget per deploy */
  maxSpendEthPerDeploy: 0.02,
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
  if (p.bufferSecs < b.minBufferSecs) problems.push(`Buffer must be at least ${b.minBufferSecs}s`);
  if (p.postTaxBps < 0 || p.postTaxBps > 500) problems.push("Post tax must be 0-500 bps");
  return problems;
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
 * and the fee+gas estimate under the per-deploy cap. Caller enforces the daily cap.
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
    unsoldMode: 0,
    eoaOnly: false,
    openEnded: true,
    postTaxBps: p.postTaxBps,
    bondVenue: 0,
    maxBuyPpm: 0,
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
