import { createPublicClient, createWalletClient, encodeDeployData, formatEther, http, isAddress, type Abi } from "viem";
import { getAccount } from "@/lib/launchpad/service";
import { ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { flagshipSpec, openFlagshipThread, seedFlagships } from "@/lib/forge/flagship";
import { FORGE_CAPS, type ForgeCaps, forgeDeployEligibility } from "@/lib/forge/caps";
import { checkVerified, explorerContractUrl, submitVerification } from "@/lib/forge/verify";
import { newId, pushEvent, updateState } from "@/lib/store";
import { AUTO_APPROVE_NOTE } from "@/lib/swarm/autonomy";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { forgeAnnounceMock, forgeAnnouncePrompt, forgeAnnounceSchema } from "@/lib/swarm/tasks";
import { sanitizeXPost, TWEET_MAX } from "@/lib/publish/x-style";
import type { Draft, ForgeProject, SwarmState } from "@/lib/types";

/**
 * Anvil execution: puts the contracts Anvil wrote on Robinhood Chain and gets
 * their source verified, one step per scheduler tick.
 *
 *   approved  -> deploy (estimate first; caps on gas, cost, balance floor)
 *              -> submit the source to the explorer and Sourcify
 *   deployed  -> poll verification every ~10 min, resubmit every third poll
 *              -> verified: create the X post with the explorer link (goes
 *                 through the normal X gates: Redline, auditor, x-guard)
 *              -> gave up: failed (contract stays live, slot freed)
 *
 * The bytecode deployed is exactly what compile.ts produced from the source
 * the gate approved; nothing here re-reads or trusts anything else. Runs only
 * while settings.autoExecuteForge is on, and never while the launch executor
 * holds the wallet.
 */

const publicClient = createPublicClient({
  chain: ROBINHOOD_CHAIN,
  transport: http(undefined, { batch: true, retryCount: 4, retryDelay: 800 }),
});

function log(msg: string): void {
  console.log(`[forge ${new Date().toISOString()}] ${msg}`);
}

interface ForgeOps {
  running: boolean;
  nextAttemptAt: number;
  nextVerifyCheckAt: number;
  failures: Record<string, number>;
}

declare global {
  var __lauraForgeOps: ForgeOps | undefined;
}

function opsState(): ForgeOps {
  return (globalThis.__lauraForgeOps ??= { running: false, nextAttemptAt: 0, nextVerifyCheckAt: 0, failures: {} });
}

const FAILURE_BACKOFF_MS = 30 * 60_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const VERIFY_CHECK_INTERVAL_MS = 10 * 60_000;
/** Resubmit the source every Nth unsuccessful check (a job can be dropped by the explorer). */
const RESUBMIT_EVERY = 3;

function envNum(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Env can only shrink the caps, never raise them. */
export function effectiveForgeCaps(): ForgeCaps {
  const caps: ForgeCaps = { ...FORGE_CAPS };
  const shrink = (key: keyof ForgeCaps, env: string) => {
    const v = envNum(env);
    if (v !== null && v < caps[key]) caps[key] = v;
  };
  shrink("maxDeploysPerDay", "FORGE_MAX_DEPLOYS_PER_DAY");
  shrink("maxDeploysPerWeek", "FORGE_MAX_DEPLOYS_PER_WEEK");
  shrink("maxDeployCostEth", "FORGE_MAX_DEPLOY_COST_ETH");
  shrink("maxDeployGas", "FORGE_MAX_DEPLOY_GAS");
  const floor = envNum("FORGE_TREASURY_FLOOR_ETH");
  if (floor !== null && floor > caps.treasuryFloorEth) caps.treasuryFloorEth = floor;
  return caps;
}

interface AbiInput {
  type: string;
  name?: string;
}

/**
 * Turns the design's string arguments into ABI values. Only scalar types are
 * accepted (uint/int, bool, address, string, bytesN); anything else fails the
 * design at compile time so it never reaches the wallet.
 */
export function parseConstructorArgs(abi: unknown[], args: string[]): unknown[] {
  const ctor = (abi as Array<{ type: string; inputs?: AbiInput[] }>).find((e) => e.type === "constructor");
  const inputs = ctor?.inputs ?? [];
  if (inputs.length !== args.length) throw new Error(`constructor takes ${inputs.length} argument(s), design supplied ${args.length}`);
  return inputs.map((inp, i) => {
    const raw = args[i].trim();
    if (/^u?int\d*$/.test(inp.type)) {
      if (!/^-?\d+$/.test(raw)) throw new Error(`argument ${inp.name ?? i} (${inp.type}) must be an integer, got "${raw}"`);
      return BigInt(raw);
    }
    if (inp.type === "bool") {
      if (raw !== "true" && raw !== "false") throw new Error(`argument ${inp.name ?? i} must be true or false`);
      return raw === "true";
    }
    if (inp.type === "address") {
      if (!isAddress(raw)) throw new Error(`argument ${inp.name ?? i} is not an address`);
      return raw;
    }
    if (inp.type === "string") return raw;
    if (/^bytes\d+$/.test(inp.type)) {
      if (!/^0x[0-9a-fA-F]+$/.test(raw)) throw new Error(`argument ${inp.name ?? i} (${inp.type}) must be hex`);
      return raw;
    }
    throw new Error(`constructor argument type ${inp.type} is not supported (scalars only)`);
  });
}

interface DeployResult {
  contractAddress: `0x${string}`;
  txHash: `0x${string}`;
  costEth: number;
}

async function deployProject(
  project: ForgeProject,
  caps: ForgeCaps,
  account: NonNullable<ReturnType<typeof getAccount>>,
): Promise<DeployResult> {
  const abi = project.abi as Abi;
  const bytecode = project.bytecode as `0x${string}`;
  const args = parseConstructorArgs(project.abi, project.constructorArgs);
  const data = encodeDeployData({ abi, bytecode, args: args as never });

  const [gas, gasPrice, balanceWei] = await Promise.all([
    publicClient.estimateGas({ account, data }),
    publicClient.getGasPrice(),
    publicClient.getBalance({ address: account.address }),
  ]);
  if (gas > BigInt(caps.maxDeployGas)) throw new Error(`deploy needs ${gas} gas; ceiling ${caps.maxDeployGas}`);
  const gasLimit = (gas * 125n) / 100n;
  const costEth = Number(formatEther(gasLimit * gasPrice));
  if (costEth > caps.maxDeployCostEth) throw new Error(`deploy would cost ~${costEth.toFixed(5)} ETH; ceiling ${caps.maxDeployCostEth}`);
  const balanceEth = Number(formatEther(balanceWei));
  if (balanceEth - costEth < caps.treasuryFloorEth) {
    throw new Error(`wallet ${balanceEth.toFixed(4)} ETH would drop under the ${caps.treasuryFloorEth} ETH floor`);
  }

  const walletClient = createWalletClient({ account, chain: ROBINHOOD_CHAIN, transport: http() });
  const txHash = await walletClient.deployContract({ abi, bytecode, args: args as never, gas: gasLimit });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`deploy reverted: ${txHash}`);
  const paid = Number(formatEther(receipt.gasUsed * (receipt.effectiveGasPrice ?? gasPrice)));
  return { contractAddress: receipt.contractAddress, txHash, costEth: paid };
}

/** Deterministic announcement when the model is unavailable; still goes through every X gate. */
export function forgeAnnounceFallback(project: ForgeProject): string {
  const url = project.explorerUrl ?? (project.contractAddress ? explorerContractUrl(project.contractAddress) : "");
  const spec = flagshipSpec(project);
  if (spec) {
    const text = `i deployed and verified the ownership market on robinhood chain: list any contract you own (nft collection, token, vault) for sale in any token, the market escrows the ownership, anyone executes the handover, seller claims the funds, 1% fee. first useful contract from the swarm, not the last. anyone can host a frontend for it. ${url} how to call it: ${spec.docUrl}`;
    if (text.length <= TWEET_MAX) return text;
    return `the ownership market is live and verified on robinhood chain: sell any contract you own, in any token, ownership escrowed, 1% fee, no admin. our first useful contract, not our last. anyone can host a frontend. ${url}`;
  }
  const text = `new on robinhood chain: ${project.title.toLowerCase()}. ${project.blurb} verified source, anyone can use it from the explorer: ${url}`;
  return text.length <= TWEET_MAX ? text : `${project.title.toLowerCase()} is live on robinhood chain, verified and open to anyone: ${url}`;
}

/** Writes the X post announcing a verified contract as an approved draft so the normal X gates read it. */
async function announceVerified(state: SwarmState, project: ForgeProject): Promise<string> {
  const resolved = resolveModel(state.settings.llmModel);
  let body = forgeAnnounceFallback(project);
  try {
    const out = await generateStructured(resolved, {
      schema: forgeAnnounceSchema,
      system: "You write LAURA's X posts. Plain sentences a stranger follows, no hashtags, no emoji, no hype, no price talk, lowercase is fine.",
      prompt: forgeAnnouncePrompt(project, flagshipSpec(project)?.docUrl ?? null),
      mock: () => forgeAnnounceMock(project),
    });
    if (!out.usedMock) {
      const candidate = sanitizeXPost(out.value.post).text;
      const url = project.explorerUrl ?? "";
      if (candidate.length > 0 && candidate.length <= TWEET_MAX && (url === "" || candidate.includes(url))) body = candidate;
    }
  } catch (err) {
    log(`announcement model call failed (${String(err).slice(0, 120)}); using the deterministic line`);
  }
  const draftId = newId("draft");
  await updateState((s) => {
    const autonomous = s.settings.autoApproveProposals;
    const draft: Draft = {
      id: draftId,
      cycleId: project.cycleId,
      agentId: "smith",
      kind: "post",
      channel: "x",
      title: `Anvil: ${project.title} is live and verified`,
      body,
      rationale:
        project.kind === "flagship"
          ? `LAURA's first flagship contract on Robinhood Chain is deployed and verified (${project.contractAddress}). The post carries the explorer link and the guide; it is the first useful contract from the swarm, not the last.`
          : `Anvil shipped a verified contract people on X asked for (${project.need.slice(0, 200)}). The post carries the explorer link so anyone can read and use it.`,
      status: autonomous ? "approved" : "pending",
      createdAt: Date.now(),
      reviewedAt: autonomous ? Date.now() : null,
      reviewerNote: autonomous ? AUTO_APPROVE_NOTE : null,
      publishedUrl: null,
      autoPublishNote: null,
    };
    s.drafts.push(draft);
    const smith = s.agents.find((a) => a.id === "smith");
    if (smith) {
      smith.stats.drafts += 1;
      if (autonomous) smith.stats.approved += 1;
    }
    const p = (s.forgeProjects ?? []).find((x) => x.id === project.id);
    if (p) p.announceDraftId = draftId;
    pushEvent(s, {
      kind: "draft.created",
      agentId: "smith",
      title: `Anvil drafted the announcement for ${project.title}`,
      detail: body,
      refId: draftId,
    });
  });
  return draftId;
}

async function failProject(projectId: string, msg: string, title: string): Promise<void> {
  await updateState((s) => {
    const p = (s.forgeProjects ?? []).find((x) => x.id === projectId);
    if (!p) return;
    p.status = "failed";
    p.error = msg;
    pushEvent(s, { kind: "forge.failed", agentId: "smith", title, detail: msg, refId: p.id });
  });
}

/**
 * Scheduler entry point. Advances at most one project by one step per tick.
 * Never throws; deploy failures back off 30 minutes and a project fails after
 * 3 consecutive errors.
 */
export async function runForgeTick(state: SwarmState): Promise<void> {
  const ops = opsState();
  if (ops.running) return;
  /* Vendored flagship contracts (audited in-repo) queue themselves once. */
  await seedFlagships(state);
  const now = Date.now();
  const projects = state.forgeProjects ?? [];

  /* Verification polling first: cheap, no wallet. */
  const deployed = projects.find((p) => p.status === "deployed" && p.contractAddress);
  if (deployed && now >= ops.nextVerifyCheckAt) {
    ops.running = true;
    ops.nextVerifyCheckAt = now + VERIFY_CHECK_INTERVAL_MS;
    try {
      const status = await checkVerified(deployed.contractAddress as string);
      if (status.verified) {
        await updateState((s) => {
          const p = (s.forgeProjects ?? []).find((x) => x.id === deployed.id);
          if (!p) return;
          p.status = "verified";
          p.verifiedAt = Date.now();
          p.verifiedVia = status.via;
          p.error = null;
          const smith = s.agents.find((a) => a.id === "smith");
          if (smith) smith.stats.published += 1;
          pushEvent(s, {
            kind: "forge.verified",
            agentId: "smith",
            title: `Verified: ${p.title} at ${p.contractAddress}`,
            detail: `${status.detail}. Read and Write tabs are live for everyone at ${p.explorerUrl}. How to use: ${p.howToUse}`,
            refId: p.id,
          });
        });
        log(`verified ${deployed.title} at ${deployed.contractAddress} via ${status.via}`);
        const verifiedProject: ForgeProject = { ...deployed, status: "verified", verifiedVia: status.via, verifiedAt: Date.now() };
        await announceVerified(state, verifiedProject);
        if (verifiedProject.kind === "flagship") await openFlagshipThread(verifiedProject);
      } else {
        const attempts = deployed.verifyAttempts + 1;
        let note = status.detail;
        if (attempts % RESUBMIT_EVERY === 0) {
          const re = await submitVerification(deployed);
          note += ` · resubmitted to ${re.submitted.join("+") || "nobody"}${re.errors.length ? ` (${re.errors.join("; ").slice(0, 200)})` : ""}`;
        }
        await updateState((s) => {
          const p = (s.forgeProjects ?? []).find((x) => x.id === deployed.id);
          if (!p) return;
          p.verifyAttempts = attempts;
          p.error = `verification pending: ${note}`.slice(0, 400);
        });
        log(`verification of ${deployed.title} pending (attempt ${attempts}): ${note.slice(0, 160)}`);
        if (attempts >= FORGE_CAPS.maxVerifyAttempts) {
          await failProject(
            deployed.id,
            `deployed at ${deployed.contractAddress} but no verifier accepted the source after ${attempts} checks: ${note}`.slice(0, 400),
            `Anvil could not get ${deployed.title} verified`,
          );
        }
      }
    } catch (err) {
      log(`verification check failed: ${String(err).slice(0, 200)}`);
    } finally {
      ops.running = false;
    }
    return;
  }

  /* Deploy step. */
  const approved = projects.find((p) => p.status === "approved");
  if (!approved) return;
  if (!state.settings.autoExecuteForge) return;
  if (now < ops.nextAttemptAt) return;
  if (globalThis.__lauraLaunchExecutor?.running) {
    log("deferring: launch executor holds the wallet this tick");
    return;
  }
  const account = getAccount();
  if (!account) return;
  const caps = effectiveForgeCaps();
  const elig = forgeDeployEligibility(state, now, caps);
  if (!elig.eligible) {
    ops.nextAttemptAt = Math.min(elig.nextEligibleAt, now + 30 * 60_000);
    return;
  }

  ops.running = true;
  try {
    const result = await deployProject(approved, caps, account);
    const explorerUrl = explorerContractUrl(result.contractAddress);
    const deployedProject: ForgeProject = {
      ...approved,
      status: "deployed",
      contractAddress: result.contractAddress,
      txHash: result.txHash,
      deployedAt: Date.now(),
      deployCostEth: result.costEth,
      explorerUrl,
    };
    await updateState((s) => {
      const p = (s.forgeProjects ?? []).find((x) => x.id === approved.id);
      if (!p) return;
      Object.assign(p, deployedProject, { error: null });
      pushEvent(s, {
        kind: "forge.deployed",
        agentId: "smith",
        title: `Anvil deployed ${p.title} (${p.contractName}) at ${result.contractAddress}`,
        detail: `${p.blurb} Gas ${result.costEth.toFixed(6)} ETH, tx ${result.txHash}. Source submitted for verification; the X post waits for the explorer to accept it. For: ${p.need.slice(0, 200)}`,
        refId: p.id,
      });
    });
    log(`deployed ${approved.title} at ${result.contractAddress} (tx ${result.txHash}, ${result.costEth.toFixed(6)} ETH)`);
    ops.failures[approved.id] = 0;

    const sub = await submitVerification(deployedProject);
    await updateState((s) => {
      const p = (s.forgeProjects ?? []).find((x) => x.id === approved.id);
      if (!p) return;
      p.verifyAttempts = 0;
      p.error = sub.submitted.length > 0 ? null : `verification submit failed: ${sub.errors.join("; ")}`.slice(0, 400);
    });
    log(`verification submitted to ${sub.submitted.join("+") || "nobody"}${sub.errors.length ? `; errors: ${sub.errors.join("; ").slice(0, 200)}` : ""}`);
    ops.nextVerifyCheckAt = Date.now() + 3 * 60_000;
  } catch (err) {
    const msg = String(err).slice(0, 300);
    const count = (ops.failures[approved.id] ?? 0) + 1;
    ops.failures[approved.id] = count;
    ops.nextAttemptAt = now + FAILURE_BACKOFF_MS;
    log(`deploy of ${approved.title} failed (attempt ${count}, backing off 30m): ${msg}`);
    if (count >= MAX_CONSECUTIVE_FAILURES) {
      await failProject(approved.id, `${count} consecutive deploy errors; slot freed. Last: ${msg}`, `Anvil deploy failed: ${approved.title}`);
    } else {
      await updateState((s) => {
        const p = (s.forgeProjects ?? []).find((x) => x.id === approved.id);
        if (p) p.error = msg;
      });
    }
  } finally {
    ops.running = false;
  }
}
