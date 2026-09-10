import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  zeroHash,
  type Abi,
} from "viem";
import { getAccount } from "@/lib/launchpad/service";
import { LAUNCHPAD, ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { QUOTE_TOKENS } from "@/lib/launchpad/earnings";
import { STONK_DEX } from "@/lib/launchpad/treasury";
import PAD_FULL_ABI_JSON from "@/lib/launchpad/StonkSafeLaunchpadV2.abi.json";
import {
  BUILDER_CAPS,
  type BuilderCaps,
  acquisitionEligibility,
  deployEligibility,
  tokenAlreadyServed,
} from "@/lib/builder/caps";
import { UTILITY_TEMPLATES, templateArtifact } from "@/lib/builder/templates";
import { pushEvent, updateState } from "@/lib/store";
import type { LaunchProposal, SwarmState, UtilityProject } from "@/lib/types";

/**
 * Builder execution: gives LAURA's launched tokens real function.
 *
 * Split of responsibilities:
 *   - the ORCHESTRATOR step (LLM) designs at most one UtilityProject per
 *     stride and queues it through the same pending -> approved review flow
 *     launches use;
 *   - THIS module executes approved projects one on-chain action per tick,
 *     and only while settings.autoExecuteUtility is true. Dashboard-only
 *     kinds (leaderboard/lore) ship immediately since they spend nothing.
 *
 * Every spend obeys BUILDER_CAPS (env can only shrink, never raise), shares
 * the treasury ETH floor, respects the launch executor's wallet mutex,
 * simulates before sending, and fails closed with a 30-minute backoff.
 * Acquisitions of LAURA's own tokens are the ONE charter-sanctioned own-token
 * purchase (charter rule 8): tiny, disclosed, utility-funding only.
 */

const PAD_ABI = PAD_FULL_ABI_JSON as Abi;

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

const ERC20_MINI_ABI = [
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
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

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

function log(msg: string): void {
  console.log(`[builder ${new Date().toISOString()}] ${msg}`);
}

const DAY_MS = 24 * 3600_000;

/* ------------------------------ Effective caps ----------------------------- */

function envNum(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * VM env overrides, SHRINK-ONLY: spend/count caps take the smaller of code
 * and env; the gap takes the larger. An env var can therefore only make the
 * builder more conservative, never unlock more spend.
 *   BUILDER_MAX_ETH_PER_ACQ, BUILDER_MAX_ETH_PER_24H,
 *   BUILDER_MIN_ACQ_GAP_HOURS, BUILDER_MAX_ACTIVE_PROJECTS,
 *   BUILDER_MAX_DEPLOYS_PER_WEEK
 */
export function effectiveBuilderCaps(): BuilderCaps {
  return {
    ...BUILDER_CAPS,
    maxEthPerAcquisition: Math.min(
      BUILDER_CAPS.maxEthPerAcquisition,
      envNum("BUILDER_MAX_ETH_PER_ACQ") ?? BUILDER_CAPS.maxEthPerAcquisition,
    ),
    maxEthPer24h: Math.min(BUILDER_CAPS.maxEthPer24h, envNum("BUILDER_MAX_ETH_PER_24H") ?? BUILDER_CAPS.maxEthPer24h),
    minAcquisitionGapHours: Math.max(
      BUILDER_CAPS.minAcquisitionGapHours,
      envNum("BUILDER_MIN_ACQ_GAP_HOURS") ?? BUILDER_CAPS.minAcquisitionGapHours,
    ),
    maxActiveProjects: Math.min(
      BUILDER_CAPS.maxActiveProjects,
      envNum("BUILDER_MAX_ACTIVE_PROJECTS") ?? BUILDER_CAPS.maxActiveProjects,
    ),
    maxDeploysPerWeek: Math.min(
      BUILDER_CAPS.maxDeploysPerWeek,
      envNum("BUILDER_MAX_DEPLOYS_PER_WEEK") ?? BUILDER_CAPS.maxDeploysPerWeek,
    ),
  };
}

/* ------------------------------- Candidates -------------------------------- */

export interface BuilderCandidate {
  proposal: LaunchProposal;
  tokenAddress: string;
  symbol: string;
  ageHours: number;
  tradeCount: number;
  graduated: boolean;
  bonded: boolean;
  earnedQuote: number;
}

/** LAURA's own deployed tokens eligible for a utility project right now. */
export function builderCandidates(state: SwarmState, now = Date.now()): BuilderCandidate[] {
  const earningsBy = new Map((state.treasury?.launches ?? []).map((e) => [e.proposalId, e]));
  return state.launches
    .filter((l) => l.status === "deployed" && l.tokenAddress && l.launchId)
    .filter((l) => (now - (l.deployedAt ?? now)) / 3600_000 >= BUILDER_CAPS.minTokenAgeHours)
    .filter((l) => !tokenAlreadyServed(state, l.tokenAddress as string))
    .map((l) => {
      const e = earningsBy.get(l.id);
      return {
        proposal: l,
        tokenAddress: (l.tokenAddress as string).toLowerCase(),
        symbol: l.symbol,
        ageHours: (now - (l.deployedAt ?? now)) / 3600_000,
        tradeCount: e?.tradeCount ?? 0,
        graduated: e?.graduated ?? false,
        bonded: e?.bonded ?? false,
        earnedQuote: e?.earnedQuote ?? 0,
      };
    })
    .sort((a, b) => b.tradeCount - a.tradeCount);
}

/** Candidate lines for the builder prompt. */
export function builderCandidatesDigest(state: SwarmState, now = Date.now()): string {
  const cands = builderCandidates(state, now);
  if (cands.length === 0) return "- No eligible tokens right now (deployed, 24h+ old, not yet served).";
  return cands
    .slice(0, 12)
    .map(
      (c) =>
        `- $${c.symbol} ${c.tokenAddress} | age ${c.ageHours.toFixed(0)}h | ${c.tradeCount} curve trades | ${
          c.bonded ? "bonded (pool live)" : c.graduated ? "graduated" : "on the curve"
        } | fees earned ${c.earnedQuote.toFixed(5)} ${c.proposal.lane === "weth" ? "WETH" : "STONK"}`,
    )
    .join("\n");
}

/** Existing utility projects, for dedupe grounding in the prompt. */
export function utilityProjectsDigest(state: SwarmState): string {
  const projects = state.utilityProjects ?? [];
  if (projects.length === 0) return "- None yet.";
  return projects
    .slice(-10)
    .map(
      (p) =>
        `- [${p.status}] ${p.kind} for $${p.tokenSymbol}: ${p.title}${
          p.deploy ? ` (deployed ${p.deploy.contractAddress})` : ""
        }`,
    )
    .join("\n");
}

/** Capacity lines for the builder prompt (slots, spend budget, deploy budget). */
export function builderCapacityDigest(state: SwarmState, now = Date.now()): string {
  const caps = effectiveBuilderCaps();
  const active = (state.utilityProjects ?? []).filter((p) => p.status === "pending" || p.status === "approved");
  const acq = acquisitionEligibility(state, now, caps);
  const dep = deployEligibility(state, now, caps);
  return [
    `- Project slots: ${active.length}/${caps.maxActiveProjects} in flight; one project per token, ever`,
    `- Acquisition budget: ${acq.eligible ? `${acq.amountEth.toFixed(4)} ETH available now` : acq.reason} (caps ${caps.maxEthPerAcquisition}/acq, ${caps.maxEthPer24h}/24h, ${caps.minAcquisitionGapHours}h gap)`,
    `- Deploy budget: ${dep.eligible ? "available" : dep.reason} (cap ${caps.maxDeploysPerWeek}/week)`,
    `- Execution flag: autoExecuteUtility is ${state.settings.autoExecuteUtility ? "ON, approved projects execute" : "OFF, projects queue until the operator enables it"}`,
  ].join("\n");
}

/* ------------------------------- Execution --------------------------------- */

declare global {
  var __lauraBuilderOps: { running: boolean; nextAttemptAt: number; failures: Record<string, number> } | undefined;
}

function opsState() {
  if (!globalThis.__lauraBuilderOps) {
    globalThis.__lauraBuilderOps = { running: false, nextAttemptAt: 0, failures: {} };
  }
  return globalThis.__lauraBuilderOps;
}

const FAILURE_BACKOFF_MS = 30 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;

async function tokenBalance(token: `0x${string}`, owner: `0x${string}`): Promise<bigint> {
  return (await publicClient.readContract({
    address: token,
    abi: ERC20_MINI_ABI,
    functionName: "balanceOf",
    args: [owner],
  })) as bigint;
}

interface AcquireResult {
  ethIn: number;
  wethIn: number;
  tokensOut: number;
  txHash: string;
  venue: "curve" | "pool";
}

/**
 * Acquires a tiny capped bag of the project's token. Venue picked from live
 * pad state: still-on-curve tokens buy through pad.buy (spends the lane's
 * quote token; only the WETH lane maps onto our ETH caps, so stonk-lane
 * tokens wait until they bond); graduated or bonded tokens buy through the
 * verified SwapRouter02 v3 path with native ETH. Simulation-first on both
 * paths; slippage floor from caps.
 */
async function acquireBag(
  project: UtilityProject,
  launchProposal: LaunchProposal,
  amountEth: number,
  caps: BuilderCaps,
  account: NonNullable<ReturnType<typeof getAccount>>,
): Promise<AcquireResult> {
  const token = project.tokenAddress as `0x${string}`;
  const lane = launchProposal.lane;
  const pad = LAUNCHPAD.pads[lane] as `0x${string}`;
  if (launchProposal.launchId == null) throw new Error("linked launch has no on-chain launch id");
  const launchId = BigInt(launchProposal.launchId);
  const launch = (await publicClient.readContract({
    address: pad,
    abi: PAD_ABI,
    functionName: "getLaunch",
    args: [launchId],
  })) as { graduated: boolean; bonded: boolean };

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const amountIn = parseEther(amountEth.toFixed(18));
  const before = await tokenBalance(token, account.address);

  if (!launch.graduated && !launch.bonded) {
    if (lane !== "weth") {
      throw new Error("token still trades on the STONK-lane curve; acquisition waits until it bonds into a pool");
    }
    const weth = QUOTE_TOKENS.weth.address;
    const wethBal = await tokenBalance(weth, account.address);
    if (wethBal < amountIn) {
      throw new Error(
        `curve buy needs ${amountEth} WETH but wallet holds ${formatEther(wethBal)}; waiting for creator fees to accrue`,
      );
    }
    const approveSim = await publicClient.simulateContract({
      account,
      address: weth,
      abi: ERC20_MINI_ABI,
      functionName: "approve",
      args: [pad, amountIn],
    });
    const approveTx = await walletClient.writeContract(approveSim.request);
    await publicClient.waitForTransactionReceipt({ hash: approveTx, timeout: 120_000 });

    const quoteSim = await publicClient.simulateContract({
      account,
      address: pad,
      abi: PAD_ABI,
      functionName: "buy",
      args: [launchId, amountIn, 0n, zeroHash, account.address],
    });
    const expected = quoteSim.result as bigint;
    const minOut = (expected * BigInt(10_000 - caps.slippageBps)) / 10_000n;
    const { request } = await publicClient.simulateContract({
      account,
      address: pad,
      abi: PAD_ABI,
      functionName: "buy",
      args: [launchId, amountIn, minOut, zeroHash, account.address],
    });
    const txHash = await walletClient.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`curve buy reverted: ${txHash}`);
    const after = await tokenBalance(token, account.address);
    return {
      ethIn: 0,
      wethIn: amountEth,
      tokensOut: Number(formatEther(after - before)),
      txHash,
      venue: "curve",
    };
  }

  /* Bonded/graduated: v3 pool path with native ETH (router wraps). Quote both
     live fee tiers read-only, take the better output. */
  let bestFee = 0;
  let bestOut = 0n;
  const swapArgs = (fee: number, minOut: bigint) =>
    ({
      tokenIn: QUOTE_TOKENS.weth.address,
      tokenOut: token,
      fee,
      recipient: account.address,
      amountIn,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }) as const;
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
    } catch {
      /* tier without a pool; expected */
    }
  }
  if (bestOut === 0n) throw new Error("no viable v3 pool for the bonded token on either fee tier");
  const minOut = (bestOut * BigInt(10_000 - caps.slippageBps)) / 10_000n;
  const { request } = await publicClient.simulateContract({
    account,
    address: STONK_DEX.router,
    abi: ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [swapArgs(bestFee, minOut)],
    value: amountIn,
  });
  const txHash = await walletClient.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
  if (receipt.status !== "success") throw new Error(`pool buy reverted: ${txHash}`);
  const after = await tokenBalance(token, account.address);
  return {
    ethIn: amountEth,
    wethIn: 0,
    tokensOut: Number(formatEther(after - before)),
    txHash,
    venue: "pool",
  };
}

interface DeployResult {
  contractAddress: string;
  txHash: string;
  fundTxHash: string | null;
  fundedTokens: number;
}

/**
 * Deploys the project's allowlisted template from the precompiled artifact and,
 * for the faucet, funds it with the acquired bag. The faucet claim amount is
 * CLAMPED so the bag always covers between faucetMinClaims and faucetMaxClaims
 * claims regardless of what the LLM proposed.
 */
async function deployTemplate(
  project: UtilityProject,
  caps: BuilderCaps,
  account: NonNullable<ReturnType<typeof getAccount>>,
): Promise<DeployResult> {
  const artifact = templateArtifact(project.kind);
  if (!artifact) throw new Error(`kind ${project.kind} has no on-chain template`);
  const token = project.tokenAddress as `0x${string}`;
  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });

  let args: readonly unknown[];
  let fundWei = 0n;
  if (project.kind === "faucet-drip") {
    const bag = await tokenBalance(token, account.address);
    if (bag === 0n) throw new Error("faucet needs an acquired bag but the wallet holds zero of the token");
    const bagTokens = Number(formatEther(bag));
    const proposed = project.faucetClaimTokens ?? bagTokens / 100;
    const claimTokens = Math.min(
      Math.max(proposed, bagTokens / caps.faucetMaxClaims),
      bagTokens / caps.faucetMinClaims,
    );
    const intervalHours = Math.min(Math.max(project.faucetIntervalHours ?? 24, 1), 168);
    args = [token, parseEther(claimTokens.toFixed(18)), BigInt(Math.round(intervalHours * 3600))] as const;
    fundWei = bag;
  } else if (project.kind === "burn-pledge") {
    args = [token] as const;
  } else {
    throw new Error(`unsupported on-chain kind ${project.kind}`);
  }

  const txHash = await walletClient.deployContract({
    abi: artifact.abi as Abi,
    bytecode: artifact.bytecode as `0x${string}`,
    args: args as never,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy reverted: ${txHash}`);
  const contractAddress = receipt.contractAddress;

  let fundTxHash: `0x${string}` | null = null;
  let fundedTokens = 0;
  if (fundWei > 0n) {
    const { request } = await publicClient.simulateContract({
      account,
      address: token,
      abi: ERC20_MINI_ABI,
      functionName: "transfer",
      args: [contractAddress, fundWei],
    });
    fundTxHash = await walletClient.writeContract(request);
    const fundReceipt = await publicClient.waitForTransactionReceipt({ hash: fundTxHash, timeout: 120_000 });
    if (fundReceipt.status !== "success") throw new Error(`faucet funding reverted: ${fundTxHash}`);
    fundedTokens = Number(formatEther(fundWei));
  }
  return { contractAddress, txHash, fundTxHash, fundedTokens };
}

/** Ships dashboard-only kinds: no chain action, the project record IS the surface. */
async function shipDashboardKind(project: UtilityProject): Promise<void> {
  await updateState((s) => {
    const p = (s.utilityProjects ?? []).find((x) => x.id === project.id);
    if (!p || p.status !== "approved") return;
    p.status = "shipped";
    p.shippedAt = Date.now();
    const builder = s.agents.find((a) => a.id === "builder");
    if (builder) builder.stats.published += 1;
    pushEvent(s, {
      kind: "utility.shipped",
      agentId: "builder",
      title: `Utility shipped: ${p.title} for $${p.tokenSymbol}`,
      detail: `${UTILITY_TEMPLATES[p.kind].describe} No chain action; renders from swarm state.`,
      refId: p.id,
    });
  });
  log(`shipped dashboard utility ${project.id} (${project.kind}) for $${project.tokenSymbol}`);
}

/**
 * Scheduler entry point: advances at most ONE approved utility project by ONE
 * step per tick (acquire, then deploy+fund on a later tick). Dashboard-only
 * kinds ship immediately and free of charge. Chain steps run only while
 * settings.autoExecuteUtility is on. Never throws; failures back off 30
 * minutes and a project is marked failed after 3 consecutive errors.
 */
export async function runBuilderTick(state: SwarmState): Promise<void> {
  const ops = opsState();
  if (ops.running) return;
  const now = Date.now();
  const approved = (state.utilityProjects ?? []).filter((p) => p.status === "approved");
  if (approved.length === 0) return;

  /* Dashboard kinds spend nothing: ship them regardless of the execution flag. */
  const dashboard = approved.find((p) => !UTILITY_TEMPLATES[p.kind].onchain);
  if (dashboard) {
    ops.running = true;
    try {
      await shipDashboardKind(dashboard);
    } catch (err) {
      log(`dashboard ship failed: ${String(err)}`);
    } finally {
      ops.running = false;
    }
    return;
  }

  if (!state.settings.autoExecuteUtility) return;
  if (now < ops.nextAttemptAt) return;
  if (globalThis.__lauraLaunchExecutor?.running) {
    log("deferring: launch executor holds the wallet this tick");
    return;
  }
  const account = getAccount();
  if (!account) return;

  const caps = effectiveBuilderCaps();
  const project = approved.find((p) => UTILITY_TEMPLATES[p.kind].onchain);
  if (!project) return;

  ops.running = true;
  try {
    const needsAcquisition = project.wantsAcquisition && !project.acquisition;
    if (needsAcquisition) {
      const launchProposal = state.launches.find(
        (l) => l.id === project.launchProposalId || (l.tokenAddress ?? "").toLowerCase() === project.tokenAddress,
      );
      if (!launchProposal) throw new Error("no launch proposal found for the project token");
      const elig = acquisitionEligibility(state, now, caps);
      if (!elig.eligible) {
        log(`acquisition waits: ${elig.reason}`);
        return;
      }
      /* Shared treasury floor: never spend the wallet under the launch-gas floor. */
      const balanceEth = Number(formatEther(await publicClient.getBalance({ address: account.address })));
      if (balanceEth - caps.treasuryFloorEth < caps.minEthPerAcquisition) {
        log(`acquisition waits: wallet ${balanceEth.toFixed(4)} ETH is at the ${caps.treasuryFloorEth} ETH floor`);
        return;
      }
      const amountEth = Math.min(elig.amountEth, balanceEth - caps.treasuryFloorEth);
      const acq = await acquireBag(project, launchProposal, amountEth, caps, account);
      await updateState((s) => {
        const p = (s.utilityProjects ?? []).find((x) => x.id === project.id);
        if (!p) return;
        p.acquisition = { ts: Date.now(), ...acq };
        pushEvent(s, {
          kind: "utility.acquired",
          agentId: "builder",
          title: `Acquired ${acq.tokensOut.toFixed(0)} $${p.tokenSymbol} for the ${p.kind} build`,
          detail: `${(acq.ethIn + acq.wethIn).toFixed(4)} ${acq.venue === "curve" ? "WETH via the launch curve" : "ETH via the v3 pool"}. tx ${acq.txHash}. Caps: ${caps.maxEthPerAcquisition}/acq, ${caps.maxEthPer24h}/24h, ${caps.minAcquisitionGapHours}h gap. Utility funding, never accumulation (charter rule 8).`,
          refId: p.id,
        });
      });
      log(`acquired ${acq.tokensOut.toFixed(2)} $${project.tokenSymbol} (${acq.venue}, tx ${acq.txHash})`);
      ops.failures[project.id] = 0;
      return; /* one chain action per tick; deploy runs next eligible tick */
    }

    const dep = deployEligibility(state, now, caps);
    if (!dep.eligible) {
      log(`deploy waits: ${dep.reason}`);
      return;
    }
    const result = await deployTemplate(project, caps, account);
    await updateState((s) => {
      const p = (s.utilityProjects ?? []).find((x) => x.id === project.id);
      if (!p) return;
      p.deploy = { ts: Date.now(), ...result };
      p.status = "shipped";
      p.shippedAt = Date.now();
      p.error = null;
      const builder = s.agents.find((a) => a.id === "builder");
      if (builder) builder.stats.published += 1;
      pushEvent(s, {
        kind: "utility.shipped",
        agentId: "builder",
        title: `Utility live: ${p.title} for $${p.tokenSymbol}`,
        detail: `${UTILITY_TEMPLATES[p.kind].contractName} deployed at ${result.contractAddress} (ownerless, audited template). tx ${result.txHash}${result.fundTxHash ? `. Funded ${result.fundedTokens.toFixed(0)} tokens (tx ${result.fundTxHash})` : ""}`,
        refId: p.id,
      });
    });
    log(`shipped ${project.kind} for $${project.tokenSymbol} at ${result.contractAddress}`);
    ops.failures[project.id] = 0;
  } catch (err) {
    const msg = String(err).slice(0, 300);
    const count = (ops.failures[project.id] ?? 0) + 1;
    ops.failures[project.id] = count;
    ops.nextAttemptAt = now + FAILURE_BACKOFF_MS;
    log(`step failed for ${project.id} (attempt ${count}, backing off 30m): ${msg}`);
    await updateState((s) => {
      const p = (s.utilityProjects ?? []).find((x) => x.id === project.id);
      if (!p) return;
      p.error = msg;
      if (count >= MAX_CONSECUTIVE_FAILURES) {
        p.status = "failed";
        pushEvent(s, {
          kind: "utility.failed",
          agentId: "builder",
          title: `Utility build failed: ${p.title} for $${p.tokenSymbol}`,
          detail: `${count} consecutive errors; slot freed. Last error: ${msg}`,
          refId: p.id,
        });
      }
    });
  } finally {
    ops.running = false;
  }
}

/** True when the last 24h saw any builder chain activity (used by digests/tests). */
export function builderActive24h(state: SwarmState, now = Date.now()): boolean {
  return (state.utilityProjects ?? []).some(
    (p) => (p.acquisition && p.acquisition.ts > now - DAY_MS) || (p.deploy && p.deploy.ts > now - DAY_MS),
  );
}
