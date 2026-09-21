import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pagerHolderSession } from "@/lib/pager/client";
import {
  PAGER_JOB_BOARD,
  PAGER_JOB_CAPS,
  createPagerJob,
  jobBoardDigest,
  jobCopyProblem,
  jobEligibility,
  pagerJobBoard,
  type PagerJob,
} from "@/lib/pager/jobs";
import { visibleCopyProblem } from "@/lib/pager/rail";
import { describeVerification, parseVerificationFromBrief, verifyJobSubmission, type JobVerification, type VerificationResult } from "@/lib/pager/verify";
import { generateStructured, type ResolvedModel } from "@/lib/swarm/llm";
import { agentSystem, foremanMock, foremanPrompt, foremanSchema, type CycleContext } from "@/lib/swarm/tasks";
import { pushEvent } from "@/lib/store";
import type { Agent, PagerJobRecord, SwarmState } from "@/lib/types";

/**
 * Foreman: the agent that hires people (operator grant 2026-09-20).
 *
 * Every other agent spends the treasury on positions, which can be sold. This
 * one spends it on a person's time, which cannot be unwound: `createJob`
 * escrows the bounty on chain the moment it is posted. So the model decides
 * WHAT to buy and the code decides whether it may: caps, the board's own copy
 * rules, and a refusal to act at all on a fallback plan.
 *
 * It also owns the other half of hiring, which is paying. A submission left
 * unreviewed pays out on timeout anyway, so ignoring one is not the safe
 * option, it is just the rude one.
 */

function log(msg: string): void {
  console.log(`[foreman ${new Date().toISOString()}] ${msg}`);
}

const BOARD_ABI = parseAbi(["function approve(uint256 id)", "function reject(uint256 id)", "function cancel(uint256 id)"]);

/** Job states that mean a person is waiting on LAURA specifically. */
const AWAITING_REVIEW = new Set(["Submitted", "submitted"]);

function isMine(job: PagerJob, wallet: string): boolean {
  return job.poster.toLowerCase() === wallet.toLowerCase();
}

/** The submissions waiting on her, rendered for the prompt. Empty is stated plainly, not omitted. */
export function pendingDigest(jobs: PagerJob[], wallet: string): string {
  const mine = jobs.filter((j) => isMine(j, wallet) && AWAITING_REVIEW.has(j.status));
  if (!mine.length) return "Nobody is waiting on a review right now.";
  return mine
    .map((j) => {
      const amt = Number(BigInt(j.amount) / 10n ** 18n);
      const proof = (j as unknown as { proof?: { text?: string; links?: string[] } | null }).proof;
      return [
        `  #${j.id} ${amt} STONKBROKER · ${j.details?.title ?? "no title"}`,
        `     asked for: ${j.details?.details ?? "no brief on record"}`,
        `     handed back: ${proof ? JSON.stringify(proof).slice(0, 500) : "proof hash only, open the job room to read it"}`,
      ].join("\n");
    })
    .join("\n");
}

async function boardWrite(fn: "approve" | "reject" | "cancel", jobId: number): Promise<string> {
  const key = process.env.SWARM_WALLET_PRIVATE_KEY;
  if (!key) throw new Error("No wallet configured (set SWARM_WALLET_PRIVATE_KEY)");
  const rpc = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  const account = privateKeyToAccount(key as `0x${string}`);
  const pub = createPublicClient({ transport: http(rpc) });
  const chainId = await pub.getChainId();
  const wallet = createWalletClient({
    account,
    transport: http(rpc),
    chain: { id: chainId, name: "robinhood", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } },
  });
  const hash = await wallet.writeContract({ address: PAGER_JOB_BOARD, abi: BOARD_ABI, functionName: fn, args: [BigInt(jobId)] });
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`${fn}(${jobId}) reverted (${hash})`);
  return hash;
}

const BOARD_STATUS: Record<string, PagerJobRecord["status"]> = {
  Open: "open",
  Accepted: "accepted",
  Submitted: "submitted",
  Paid: "paid",
  Cancelled: "cancelled",
  Expired: "expired",
};

/**
 * Rebuild the local record of LAURA's jobs from the board.
 *
 * The caps and the review loop both read `state.pagerJobs`, and that is a
 * cache, not the truth: a state write can be lost to a concurrent save, and
 * when it is, a live escrow silently stops counting against the caps and
 * becomes unapprovable. The board is the truth, so every run starts by
 * agreeing with it. The check is recovered from the published brief, which is
 * the same text the worker was shown and is committed on chain by hash.
 */
export function reconcileJobsFromBoard(state: SwarmState, board: PagerJob[], wallet: string): string[] {
  const notes: string[] = [];
  const existing = new Map((state.pagerJobs ?? []).map((r) => [r.jobId, r]));
  for (const job of board) {
    if (!isMine(job, wallet)) continue;
    const status = BOARD_STATUS[job.status] ?? "open";
    const amount = Number(BigInt(job.amount) / 10n ** 18n);
    const verify = job.details ? (parseVerificationFromBrief(job.details.details) ?? undefined) : undefined;
    const record = existing.get(job.id);
    if (!record) {
      existing.set(job.id, {
        jobId: job.id,
        title: job.details?.title ?? `job ${job.id}`,
        amount,
        /* Unknown from chain; dated now so a recovered job still occupies its
           open slot rather than looking like ancient history. */
        postedAt: Date.now(),
        deadline: job.deadline,
        txHash: "",
        status,
        verify,
      });
      notes.push(`recovered job ${job.id} (${status}, ${amount} STONKBROKER) from the board`);
      continue;
    }
    if (record.status !== status) {
      record.status = status;
      notes.push(`job ${job.id} is now ${status}`);
    }
    if (!record.verify && verify) record.verify = verify;
  }
  state.pagerJobs = [...existing.values()].sort((a, b) => a.jobId - b.jobId);
  return notes;
}

export interface ForemanResult {
  posted: number;
  reviewed: number;
  held: boolean;
  notes: string[];
}

export async function runForeman(
  state: SwarmState,
  agent: Agent,
  resolved: ResolvedModel,
  ctx: CycleContext,
  floor: string,
): Promise<ForemanResult> {
  const notes: string[] = [];
  const wallet = (await pagerHolderSession()).wallet;
  const board = await pagerJobBoard();
  notes.push(...reconcileJobsFromBoard(state, board, wallet));

  const out = await generateStructured(resolved, {
    schema: foremanSchema,
    system: agentSystem(agent),
    prompt: foremanPrompt(ctx, { board: jobBoardDigest(board, wallet), pending: pendingDigest(board, wallet), floor }),
    mock: foremanMock,
  });

  /* A fallback plan is not a decision. Nothing here is reversible, so the
     mock never reaches the chain. */
  if (out.usedMock) {
    pushEvent(state, {
      kind: "pager.job",
      agentId: "foreman",
      refId: null,
      title: "Foreman held (fallback, no live model)",
      detail: "No job was posted and no submission was reviewed: hiring a person and paying one both need a live judgment.",
    });
    return { posted: 0, reviewed: 0, held: true, notes: ["no live model"] };
  }

  let posted = 0;
  let reviewed = 0;
  for (const a of out.value.actions.slice(0, 3)) {
    let verifiedNote: VerificationResult | null = null;
    try {
      if (a.action === "hold") {
        notes.push(`hold: ${a.reason.slice(0, 160)}`);
        continue;
      }

      if (a.action === "approve" || a.action === "reject" || a.action === "cancel") {
        if (!a.jobId) {
          notes.push(`${a.action} skipped: no job id`);
          continue;
        }
        const job = board.find((j) => j.id === a.jobId);
        if (!job) {
          notes.push(`${a.action} skipped: job ${a.jobId} is not on the board`);
          continue;
        }
        /* Paying out of someone else's escrow is not hers to do, and the
           board would refuse it anyway; catching it here keeps the reason
           readable instead of surfacing as a revert. */
        if (!isMine(job, wallet)) {
          notes.push(`${a.action} refused: job ${a.jobId} was posted by ${job.poster.slice(0, 10)}, not LAURA`);
          continue;
        }
        if ((a.action === "approve" || a.action === "reject") && !AWAITING_REVIEW.has(job.status)) {
          notes.push(`${a.action} refused: job ${a.jobId} is ${job.status}, nothing has been submitted to judge`);
          continue;
        }
        /* An approval releases money, so the machine check decides it, not
           the model's read of the submission. A check that cannot run is a
           refusal: the job keeps its deadline and gets looked at again next
           cycle, which is the safe side to fail on. */
        if (a.action === "approve") {
          const recorded = (state.pagerJobs ?? []).find((r) => r.jobId === a.jobId);
          const check = recorded?.verify ?? (job.details ? parseVerificationFromBrief(job.details.details) : null);
          if (!check) {
            notes.push(`approve refused: job ${a.jobId} has no recorded check, so there is nothing to verify it against`);
            continue;
          }
          const proof = (job as unknown as { proof?: { text?: string; links?: string[] } | null }).proof;
          const result = await verifyJobSubmission(check, proof);
          if (!result.verified) {
            notes.push(`approve refused on job ${a.jobId}: ${result.reason}`);
            pushEvent(state, {
              kind: "pager.job",
              agentId: "foreman",
              refId: String(a.jobId),
              title: `Foreman held job #${a.jobId}: the check did not pass`,
              detail: `${result.reason} · ${JSON.stringify(result.evidence).slice(0, 300)}`,
            });
            continue;
          }
          verifiedNote = result;
        }
        const hash = await boardWrite(a.action, a.jobId);
        reviewed += 1;
        const record = (state.pagerJobs ?? []).find((r) => r.jobId === a.jobId);
        if (record) record.status = a.action === "approve" ? "paid" : a.action === "cancel" ? "cancelled" : "open";
        pushEvent(state, {
          kind: "pager.job",
          agentId: "foreman",
          refId: String(a.jobId),
          title: `Foreman ${a.action}d job #${a.jobId}: ${job.details?.title ?? "untitled"}`,
          detail: [a.reason.slice(0, 400), verifiedNote ? `check passed: ${verifiedNote.reason} · ${JSON.stringify(verifiedNote.evidence).slice(0, 240)}` : null, hash]
            .filter(Boolean)
            .join(" · "),
        });
        log(`${a.action} job ${a.jobId} → ${hash}`);
        continue;
      }

      /* post */
      if (!a.title || !a.details) {
        notes.push("post skipped: a job needs a title and a brief");
        continue;
      }
      /* The whole point of the directive: no check, no job. Work she cannot
         confirm is work she cannot pay for without guessing. */
      if (!a.verify) {
        notes.push("post refused: no check declared, and she only hires for work an API can confirm");
        continue;
      }
      const verify: JobVerification =
        a.verify.kind === "x-post"
          ? { kind: "x-post", mustInclude: a.verify.mustInclude, ...(a.verify.host ? { mustLinkHost: a.verify.host } : {}) }
          : { kind: "url", mustInclude: a.verify.mustInclude, ...(a.verify.host ? { mustBeHost: a.verify.host } : {}) };
      /* State the check in the brief itself. The worker is measured against
         it, so they get to read it before they start rather than discover it
         in a rejection. */
      const stated = describeVerification(verify);
      const details = a.details.includes(stated) ? a.details : `${a.details.trim()} ${stated}`;
      const spec = {
        title: a.title,
        details,
        links: a.links ?? [],
        amount: Math.floor(a.amount ?? 0),
        durationSec: Math.round((a.durationDays ?? 7) * 86_400),
      };
      const copy = visibleCopyProblem(spec.title) ?? visibleCopyProblem(spec.details) ?? jobCopyProblem(spec);
      if (copy) {
        notes.push(`post refused: ${copy}`);
        continue;
      }
      const elig = await jobEligibility(state, spec);
      if (!elig.eligible) {
        notes.push(`post refused: ${elig.reason}`);
        continue;
      }
      const { jobId, txHash } = await createPagerJob(spec);
      posted += 1;
      const record: PagerJobRecord = {
        jobId,
        title: spec.title,
        amount: spec.amount,
        postedAt: Date.now(),
        deadline: Math.floor(Date.now() / 1000) + spec.durationSec,
        txHash,
        status: "open",
        verify,
      };
      state.pagerJobs = [...(state.pagerJobs ?? []), record];
      pushEvent(state, {
        kind: "pager.job",
        agentId: "foreman",
        refId: String(jobId),
        title: `Foreman hired: #${jobId} for ${spec.amount} STONKBROKER — ${spec.title}`,
        detail: `${a.reason.slice(0, 400)} · ${txHash}`,
      });
      log(`posted job ${jobId} (${spec.amount} STONKBROKER) → ${txHash}`);
    } catch (err) {
      notes.push(`${a.action} failed: ${String(err).slice(0, 200)}`);
      log(`${a.action} threw: ${String(err).slice(0, 200)}`);
    }
  }

  if (!posted && !reviewed) {
    pushEvent(state, {
      kind: "pager.job",
      agentId: "foreman",
      refId: null,
      title: "Foreman held: nothing hired this cycle",
      detail: notes.join(" · ").slice(0, 600) || out.value.rationale.slice(0, 600),
    });
  }
  return { posted, reviewed, held: !posted && !reviewed, notes };
}

export { PAGER_JOB_CAPS };
