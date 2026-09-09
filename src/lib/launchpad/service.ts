import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseEventLogs,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { LAUNCHPAD, PAD_ABI, ROBINHOOD_CHAIN, type PadLane } from "@/lib/launchpad/contracts";
import type { LaunchProposal } from "@/lib/types";

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

function getAccount() {
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
