import { createPublicClient, createWalletClient, encodeDeployData, formatEther, http, isAddress, type Abi } from "viem";
import { getAccount } from "@/lib/launchpad/service";
import { ROBINHOOD_CHAIN } from "@/lib/launchpad/contracts";
import { flagshipSpec, openFlagshipThread, seedFlagships } from "@/lib/forge/flagship";
import { FORGE_CAPS, type ForgeCaps, forgeDeployEligibility } from "@/lib/forge/caps";
import { checkVerified, explorerAddressUrl, explorerContractUrl, submitVerification } from "@/lib/forge/verify";
import { newId, pushEvent, updateState } from "@/lib/store";
import { AUTO_APPROVE_NOTE } from "@/lib/swarm/autonomy";
import { generateStructured, resolveModel } from "@/lib/swarm/llm";
import { forgeAnnounceMock, forgeAnnouncePrompt, forgeAnnounceSchema, type ForgeAnnounceProject } from "@/lib/swarm/tasks";
import { digestText, functionDigest, isConstantGetter } from "@/lib/forge/abi-digest";
import { contractPageUrl } from "@/lib/forge/caps";
import { sanitizeXPost, TWEET_MAX } from "@/lib/publish/x-style";
import { recentXPosts } from "@/lib/publish/x-guard";
import { captureScreenshot } from "@/lib/publish/screenshot";
import type { Draft, DraftMedia, ForgeProject, SwarmState } from "@/lib/types";

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
    /* With a hosted frontend the post carries the frontend link and the short
       explorer link (the guide is one click away on the frontend); otherwise
       the explorer link and the guide. Raw characters count on X's ledger here. */
    const explorerShort = project.contractAddress ? explorerAddressUrl(project.contractAddress) : url;
    const links = (spec.frontendUrl ? [spec.frontendUrl, explorerShort] : [url, spec.docUrl]).join(" ");
    const text = `${spec.fallbackPost} ${links}`;
    if (text.length <= TWEET_MAX) return text;
    const short = `${project.title.toLowerCase()} is live and verified on robinhood chain. ${spec.frontendUrl ?? url}`;
    return short.length <= TWEET_MAX ? short : `${project.title.toLowerCase()} is live on robinhood chain: ${url}`;
  }
  const text = `new on robinhood chain: ${project.title.toLowerCase()}. ${project.blurb} verified source, anyone can use it from the explorer: ${url}`;
  return text.length <= TWEET_MAX ? text : `${project.title.toLowerCase()} is live on robinhood chain, verified and open to anyone: ${url}`;
}

/**
 * Picture for a contract announcement: the flagship's own frontend when it
 * has one (The Lab for the market and its registry), otherwise the contract's
 * page on LAURA's site, where every read and write function is explained.
 * Null whenever Chromium cannot deliver (text-only post).
 */
export async function flagshipScreenshot(project: ForgeProject): Promise<DraftMedia | null> {
  const spec = flagshipSpec(project);
  if (spec?.frontendUrl) {
    return captureScreenshot(spec.frontendUrl, {
      name: `flagship-${spec.key}`,
      alt: `${spec.title} on Robinhood Chain: ${spec.frontendUrl}. ${spec.blurb}`.slice(0, 1000),
    });
  }
  if (!project.contractAddress) return null;
  const url = contractPageUrl(project.contractAddress);
  return captureScreenshot(url, {
    name: `contract-${project.contractAddress.toLowerCase()}`,
    alt: `${project.title} (${project.contractName}) on Robinhood Chain, every read and write function explained: ${url}. ${project.blurb}`.slice(0, 1000),
    /* The page renders from the public snapshot; the project may take a few
       minutes to appear there after verification. */
    readyText: project.contractName,
  });
}

/** The project as the announcement prompt sees it: links plus the ABI digest. */
function announceView(project: ForgeProject): ForgeAnnounceProject {
  return {
    title: project.title,
    blurb: project.blurb,
    need: project.need,
    howToUse: project.howToUse,
    contractName: project.contractName,
    explorerUrl: project.explorerUrl ?? (project.contractAddress ? explorerContractUrl(project.contractAddress) : null),
    sourceAuthor: project.sourceAuthor,
    pageUrl: project.contractAddress ? contractPageUrl(project.contractAddress) : null,
    functions: digestText(functionDigest(project.abi)),
    functionNotes: project.functionNotes ?? null,
  };
}

/**
 * Deterministic usage reply when the model is unavailable or its reply fails
 * the checks: the functions people will use, read then write, and the link
 * where every one is explained.
 */
export function forgeUsageFallback(project: ForgeProject): string {
  const d = functionDigest(project.abi);
  const reads = d.reads.filter((f) => !isConstantGetter(f)).map((f) => f.name);
  const writes = d.writes.map((f) => f.name);
  const link = project.contractAddress ? contractPageUrl(project.contractAddress) : project.explorerUrl ?? "";
  const clip = (names: string[], budget: number) => {
    const out: string[] = [];
    for (const n of names) {
      const next = [...out, n].join(", ");
      if (next.length + (out.length + 1 < names.length ? 9 : 0) > budget) break;
      out.push(n);
    }
    return out.join(", ") + (out.length > 0 && out.length < names.length ? " and more" : "");
  };
  const frame = (r: string, w: string) => `how to use it: read ${r} for free from the explorer's Read tab; write ${w} from the Write tab with a connected wallet. every function explained: ${link}`;
  const room = TWEET_MAX - frame("", "").length;
  const readBudget = Math.max(0, Math.floor(room * (writes.length ? 0.45 : 1)));
  const r = clip(reads, readBudget) || "its state";
  const w = clip(writes, Math.max(0, room - r.length)) || "to it";
  const text = frame(r, w);
  if (text.length <= TWEET_MAX) return text;
  return `how to use it: the Read tab answers for free, the Write tab takes a transaction from your wallet. every function explained: ${link}`.slice(0, TWEET_MAX);
}

/** Announcement drafts per project: the first, then redrafts after a hold or veto at the X gate. */
export const MAX_ANNOUNCE_ATTEMPTS = 5;
/** Gap between a refused announcement and its redraft (lets the same cycle's reviewers finish). */
const REANNOUNCE_GAP_MS = 20 * 60_000;

async function announceVerified(state: SwarmState, project: ForgeProject, previous: { body: string; reason: string } | null = null): Promise<string> {
  const resolved = resolveModel(state.settings.llmModel);
  let body = forgeAnnounceFallback(project);
  let followUp = forgeUsageFallback(project);
  let notes: Record<string, string> = { ...(project.functionNotes ?? {}) };
  const view = announceView(project);
  try {
    const out = await generateStructured(resolved, {
      schema: forgeAnnounceSchema,
      system: "You write LAURA's X posts. Plain sentences a stranger follows, no hashtags, no emoji, no hype, no price talk, lowercase is fine.",
      prompt: forgeAnnouncePrompt(view, flagshipSpec(project), previous),
      mock: () => forgeAnnounceMock(view),
    });
    if (!out.usedMock) {
      const candidate = sanitizeXPost(out.value.post).text;
      const spec = flagshipSpec(project);
      /* Flagship: explorer link (short or full form) and the frontend link.
         Anvil design: the contract page link (it links the explorer). */
      const explorerOk =
        !project.contractAddress || candidate.toLowerCase().includes(`/address/${project.contractAddress}`.toLowerCase());
      const frontendOk = !spec?.frontendUrl || candidate.includes(spec.frontendUrl);
      const pageOk = !view.pageUrl || candidate.toLowerCase().includes(view.pageUrl.toLowerCase());
      const linksOk = spec ? explorerOk && frontendOk : pageOk || explorerOk;
      if (candidate.length > 0 && candidate.length <= TWEET_MAX && linksOk) body = candidate;
      /* The usage reply must carry a way in: the page or the explorer. */
      const reply = sanitizeXPost(out.value.usageReply).text;
      const replyLinked =
        (view.pageUrl && reply.toLowerCase().includes(view.pageUrl.toLowerCase())) ||
        (project.contractAddress && reply.toLowerCase().includes(`/address/${project.contractAddress}`.toLowerCase()));
      if (reply.length >= 40 && reply.length <= TWEET_MAX && replyLinked && !/(^|\s)#\w/.test(reply)) followUp = reply;
      const known = new Set(functionDigest(project.abi).reads.concat(functionDigest(project.abi).writes).map((f) => f.name));
      for (const n of out.value.functionNotes) {
        if (known.has(n.name) && !notes[n.name]) notes[n.name] = n.note.trim();
      }
    }
  } catch (err) {
    log(`announcement model call failed (${String(err).slice(0, 120)}); using the deterministic line`);
  }
  if (Object.keys(notes).length === 0) notes = project.functionNotes ?? {};
  /* A flagship with a frontend is announced with a picture of that frontend
     (operator, 2026-09-13: "with a link to what it does and screenshots if
     possible"). Best effort: no picture, text-only post. */
  const media = await flagshipScreenshot(project);
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
      rationale: `${
        project.kind === "flagship"
          ? `LAURA's flagship contract ${project.title} on Robinhood Chain is deployed and verified (${project.contractAddress}). The post carries the links (frontend when there is one, explorer, guide); useful contracts from the swarm, not the last.`
          : `Anvil shipped a verified contract people on X asked for (${project.need.slice(0, 200)}). The post carries the explorer link so anyone can read and use it.`
      }${previous ? `\n\nRedraft ${(project.announceAttempts ?? 0) + 1}/${MAX_ANNOUNCE_ATTEMPTS}: the previous announcement was refused at the X gate (${previous.reason.slice(0, 300)}).` : ""}`,
      status: autonomous ? "approved" : "pending",
      createdAt: Date.now(),
      reviewedAt: autonomous ? Date.now() : null,
      reviewerNote: autonomous ? AUTO_APPROVE_NOTE : null,
      publishedUrl: null,
      autoPublishNote: null,
      media: media ? [media] : null,
      followUp,
    };
    s.drafts.push(draft);
    const smith = s.agents.find((a) => a.id === "smith");
    if (smith) {
      smith.stats.drafts += 1;
      if (autonomous) smith.stats.approved += 1;
    }
    const p = (s.forgeProjects ?? []).find((x) => x.id === project.id);
    if (p) {
      p.announceDraftId = draftId;
      p.announceAttempts = (p.announceAttempts ?? 0) + 1;
      if (Object.keys(notes).length > 0) p.functionNotes = { ...(p.functionNotes ?? {}), ...notes };
    }
    pushEvent(s, {
      kind: "draft.created",
      agentId: "smith",
      title: previous ? `Anvil redrafted the announcement for ${project.title}` : `Anvil drafted the announcement for ${project.title}`,
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
 * Redraft an announcement the X gate refused (Redline hold or Auditor veto):
 * the reason goes into the prompt, at most MAX_ANNOUNCE_ATTEMPTS drafts per
 * project, one redraft per pass, no wallet involved. Runs on the outbound
 * loop, not the cycle tick. The Lab's first announcement was held 2026-09-13
 * 18:57 UTC for not saying what The Lab is; without this the project would
 * have stayed unannounced forever.
 */
export async function runForgeAnnounceTick(state: SwarmState): Promise<boolean> {
  const now = Date.now();
  const projects = state.forgeProjects ?? [];
  /* Announcements drafted before the usage reply existed get the
     deterministic one, so no contract goes out without its how-to. */
  const unreplied = projects.filter((p) => {
    if (p.status !== "verified" || !p.announceDraftId) return false;
    const d = state.drafts.find((x) => x.id === p.announceDraftId);
    return Boolean(d && d.status === "approved" && d.followUp === undefined);
  });
  if (unreplied.length > 0) {
    await updateState((s) => {
      for (const p of unreplied) {
        const d = s.drafts.find((x) => x.id === p.announceDraftId);
        if (d && d.followUp === undefined) d.followUp = forgeUsageFallback(p);
      }
    });
    log(`added the usage reply to ${unreplied.length} pending announcement(s): ${unreplied.map((p) => p.title).join(", ")}`);
  }
  const refused = projects.find((p) => {
    if (p.status !== "verified" || !p.announceDraftId) return false;
    if ((p.announceAttempts ?? 1) >= MAX_ANNOUNCE_ATTEMPTS) return false;
    const d = state.drafts.find((x) => x.id === p.announceDraftId);
    return Boolean(d && d.status === "rejected" && now - (d.reviewedAt ?? d.createdAt) >= REANNOUNCE_GAP_MS);
  });
  if (!refused) return false;
  const prior = state.drafts.find((x) => x.id === refused.announceDraftId);
  /* A style veto names the earlier post by URL; the writer needs its text to
     write something else (attempt 2 of The Lab collided with the Ownership
     Market post: same opening, same "sell ownership of a contract" clause). */
  let reason = prior?.reviewerNote ?? "refused at the X gate";
  const cited = new Set(reason.match(/https:\/\/x\.com\/\S+/g) ?? []);
  if (cited.size > 0) {
    const posts = await recentXPosts(40);
    for (const e of posts) {
      if (cited.has(e.url)) reason += ` That earlier post read: "${e.text.replace(/\s+/g, " ").trim()}". Do not reuse its opening, its verbs or its phrasing; say something that post did not.`;
    }
  }
  try {
    const id = await announceVerified(state, refused, { body: prior?.body ?? "", reason });
    log(`redrafted the announcement for ${refused.title} after the X gate refused ${refused.announceDraftId}: ${id} (attempt ${(refused.announceAttempts ?? 1) + 1}/${MAX_ANNOUNCE_ATTEMPTS})`);
    return true;
  } catch (err) {
    log(`redraft for ${refused.title} failed: ${String(err).slice(0, 200)}`);
    return false;
  }
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
